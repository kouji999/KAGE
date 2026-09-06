// Stage 'send' (T10j): eksekusi keputusan mode+risk.
// AUTO+LOW/MED → enqueue queue. HIGH/APPROVAL → approval request. ASSIST → hold draft.
// Selalu persist pipeline_result ke pesan IN (finally).

import { config } from '../../config/index.js';
import { childLogger } from '../../config/logger.js';
import type { RiskLevel } from '../../domain/entities.js';
import {
  ApprovalRepository,
  MessageRepository,
  NotificationRepository,
} from '../../storage/index.js';
import { resolveAction } from '../modes/modes.js';
import { assertSafeToSend, type PipelineContext, type Stage } from './pipeline.js';

const log = childLogger('pipeline:send');

/** Input enqueueSend — kompatibel dengan SendQueue.enqueueSend. */
export interface EnqueueSendInput {
  conversationId: number;
  contactJid: string;
  body: string;
  riskLevel: RiskLevel;
  messageId?: number;
}

export interface SendQueueLike {
  enqueueSend(msg: EnqueueSendInput): Promise<void>;
}

/** Deps yang di-inject saat wiring (src/index.ts). */
export interface CoreDeps {
  queue: SendQueueLike;
}

export class SendStage implements Stage {
  readonly name = 'send';

  constructor(private readonly deps: CoreDeps) {}

  async execute(ctx: PipelineContext): Promise<void> {
    try {
      if (ctx.decision === 'skipped' || ctx.decision === 'held') {
        // keputusan sudah diambil stage sebelumnya — cukup persist
        return;
      }

      if (!ctx.conversation) {
        ctx.decision = 'held';
        ctx.decisionNote = 'conversation hilang sebelum send';
        return;
      }
      if (ctx.draft === '') {
        ctx.decision = 'held';
        ctx.decisionNote = 'draft kosong';
        return;
      }

      const conv = ctx.conversation;
      const action = resolveAction(ctx.mode, ctx.riskLevel, ctx.conversationTakenOver);

      switch (action.action) {
        case 'skip': {
          ctx.decision = 'skipped';
          ctx.decisionNote = action.note;
          break;
        }

        case 'hold': {
          // ASSIST: draft disimpan utk owner, TIDAK pernah kirim.
          const out = MessageRepository.insert({
            waMessageId: '',
            conversationId: conv.id,
            contactJid: conv.contact_jid,
            direction: 'out',
            body: ctx.draft,
            status: 'pending',
            riskLevel: ctx.riskLevel,
          });
          ctx.outboundMessageId = out.id;
          NotificationRepository.add('assist_draft', {
            contactJid: conv.contact_jid,
            draft: ctx.draft,
            messageId: out.id,
          });
          ctx.decision = 'held';
          ctx.decisionNote = action.note;
          break;
        }

        case 'approval': {
          const approval = ApprovalRepository.create({
            messageId: ctx.inMessageRowId,
            conversationId: conv.id,
            contactJid: conv.contact_jid,
            draftBody: ctx.draft,
            riskLevel: ctx.riskLevel,
          });
          const out = MessageRepository.insert({
            waMessageId: '',
            conversationId: conv.id,
            contactJid: conv.contact_jid,
            direction: 'out',
            body: ctx.draft,
            status: 'pending',
            riskLevel: ctx.riskLevel,
          });
          ctx.outboundMessageId = out.id;
          NotificationRepository.add('approval_pending', {
            approvalId: approval.id,
            contactJid: conv.contact_jid,
            draft: ctx.draft,
            risk: ctx.riskLevel,
            messageId: out.id,
          });
          ctx.decision = 'approval';
          ctx.decisionNote = `menunggu approval owner (${action.note})`;
          break;
        }

        case 'send': {
          // hard rule defense-in-depth: HIGH tidak pernah lewat jalur ini
          assertSafeToSend(ctx);

          if (config.voice.enabled && config.voice.mode !== 'text') {
            ctx.replyAsVoice = true; // queue yang urus TTS + fallback teks
          }

          await this.deps.queue.enqueueSend({
            conversationId: conv.id,
            contactJid: conv.contact_jid,
            body: ctx.draft,
            riskLevel: ctx.riskLevel,
          });
          ctx.decision = 'queued';
          ctx.decisionNote = `queued (${action.note})${ctx.replyAsVoice ? ', voice preferred' : ''}`;
          break;
        }
      }
    } catch (err) {
      log.error(
        { jid: ctx.incoming.jid, err: err instanceof Error ? err.message : String(err) },
        'send stage failed',
      );
      ctx.decision = 'held';
      ctx.decisionNote = `send error: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      this.persistResult(ctx);
    }
  }

  private persistResult(ctx: PipelineContext): void {
    if (ctx.inMessageRowId <= 0) return;
    try {
      MessageRepository.updatePipelineResult(ctx.inMessageRowId, {
        decision: ctx.decision,
        note: ctx.decisionNote,
        intent: ctx.intent,
        strategy: ctx.strategy,
        risk: ctx.riskLevel,
        draft: ctx.draft,
        reasons: ctx.riskReasons,
      });
    } catch (err) {
      log.warn(
        { msgId: ctx.inMessageRowId, err: err instanceof Error ? err.message : String(err) },
        'failed to persist pipeline_result',
      );
    }
  }
}
