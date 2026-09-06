// Pipeline kernel (T9): context object, Stage contract, sequential runner.
// Wiring stage-order + deps terjadi di src/index.ts (lane lain).

import { childLogger } from '../../config/logger.js';
import type {
  Contact,
  Conversation,
  MemoryEntry,
  Message,
  Mode,
  RiskLevel,
} from '../../domain/entities.js';
import type { IncomingMessage } from '../../domain/whatsapp-provider.js';

const log = childLogger('pipeline');

/**
 * 'pending' = belum diputuskan (initial). Stage akhir menulis nilai final:
 * sent | queued | approval | held | skipped.
 */
export type PipelineDecision = 'pending' | 'sent' | 'queued' | 'approval' | 'held' | 'skipped';

export interface PipelineContext {
  incoming: IncomingMessage;
  contact: Contact | null;
  conversation: Conversation | null;
  /** oldest-first, TANPA pesan masuk yang sedang diproses */
  history: Message[];
  /** newest-first */
  memory: MemoryEntry[];
  /** row id pesan IN di messages (0 = belum tersimpan) */
  inMessageRowId: number;
  intent: string;
  intentNotes: string;
  strategy: string;
  draft: string;
  riskLevel: RiskLevel;
  mode: Mode;
  conversationTakenOver: boolean;
  decision: PipelineDecision;
  decisionNote: string;
  outboundMessageId: number | null;
  riskReasons: string[];
  personality: string;
  relationSummary: string;
  replyAsVoice: boolean;
  audioBase64: string | null;
}

export interface Stage {
  name: string;
  execute(ctx: PipelineContext): Promise<void>;
}

export function createPipelineContext(incoming: IncomingMessage): PipelineContext {
  return {
    incoming,
    contact: null,
    conversation: null,
    history: [],
    memory: [],
    inMessageRowId: 0,
    intent: 'other',
    intentNotes: '',
    strategy: 'reply',
    draft: '',
    riskLevel: 'LOW',
    mode: 'AUTO',
    conversationTakenOver: false,
    decision: 'pending',
    decisionNote: '',
    outboundMessageId: null,
    riskReasons: [],
    personality: '',
    relationSummary: '',
    replyAsVoice: false,
    audioBase64: null,
  };
}

/**
 * Hard rule sebelum kirim apa pun: HIGH risk TIDAK BOLEH langsung terkirim.
 * Jalur approval bypass pipeline-send (approval di-create, kirim terjadi
 * setelah owner memutuskan — di luar stage ini).
 */
export function assertSafeToSend(ctx: PipelineContext): void {
  if (ctx.riskLevel === 'HIGH') {
    throw new Error(
      `assertSafeToSend: HIGH risk draft must go through approval, never direct send. reasons=${
        ctx.riskReasons.join('; ') || '-'
      }`,
    );
  }
}

export class Pipeline {
  private readonly stages: Stage[];

  constructor(...stages: Stage[]) {
    this.stages = stages;
  }

  /** Jalankan stage berurutan. Berhenti dini saat decision === 'skipped'. */
  async run(ctx: PipelineContext): Promise<void> {
    for (const stage of this.stages) {
      const started = Date.now();
      try {
        await stage.execute(ctx);
      } catch (err) {
        // degrade safe: satu stage gagal tidak boleh mematikan seluruh run
        log.error(
          { stage: stage.name, jid: ctx.incoming.jid, err: errMsg(err) },
          'pipeline stage failed',
        );
        if (ctx.decision !== 'skipped') {
          ctx.decision = 'held';
          ctx.decisionNote = `stage '${stage.name}' error: ${errMsg(err)}`;
        }
      }
      log.debug(
        { stage: stage.name, ms: Date.now() - started, decision: ctx.decision },
        'stage done',
      );
      if (ctx.decision === 'skipped') return;
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
