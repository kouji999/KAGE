// Stage 'message' (T10a): validasi + simpan pesan IN.
// Conversation di-ensure di sini (idempotent) karena insert pesan butuh conversation_id;
// context stage nanti re-ensure (balikin row yang sama).

import { ConversationRepository, MessageRepository, OwnerRepository } from '../../storage/index.js';
import type { PipelineContext, Stage } from './pipeline.js';

/** DM: individual phone JID (@s.whatsapp.net) ATAU LID (@lid — identitas WA baru,
 *  dipakai untuk banyak akun sekarang). Group (@g.us) & broadcast di-skip adapter. */
const DM_JID_RE = /^\d+@(s\.whatsapp\.net|lid)$/;

export class MessageStage implements Stage {
  readonly name = 'message';

  async execute(ctx: PipelineContext): Promise<void> {
    const body = ctx.incoming.body.trim();
    if (body === '') {
      ctx.decision = 'skipped';
      ctx.decisionNote = 'empty body';
      return;
    }
    if (!DM_JID_RE.test(ctx.incoming.jid)) {
      ctx.decision = 'skipped';
      ctx.decisionNote = `unsupported jid: ${ctx.incoming.jid}`;
      return;
    }
    ctx.incoming.body = body; // normalisasi utk stage berikutnya

    const owner = OwnerRepository.get();
    const conv = ConversationRepository.ensureForJid(ctx.incoming.jid, owner.default_mode);

    const row = MessageRepository.insert({
      waMessageId: ctx.incoming.waMessageId,
      conversationId: conv.id,
      contactJid: ctx.incoming.jid,
      direction: 'in',
      body,
      status: 'delivered',
      pipelineResult: {
        receivedAt: new Date(
          Number.isFinite(ctx.incoming.timestamp) && ctx.incoming.timestamp > 0
            ? ctx.incoming.timestamp
            : Date.now(),
        ).toISOString(),
      },
    });
    ctx.inMessageRowId = row.id;
    // outboundMessageId tetap null — pesan OUT dibuat nanti saat send/hold/approval.
  }
}
