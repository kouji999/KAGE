// Stage 'context' (T10c): conversation + mode + taken_over + history.

import { config } from '../../config/index.js';
import { ConversationRepository, MessageRepository, OwnerRepository } from '../../storage/index.js';
import type { PipelineContext, Stage } from './pipeline.js';

export class ContextStage implements Stage {
  readonly name = 'context';

  async execute(ctx: PipelineContext): Promise<void> {
    if (ctx.decision === 'skipped') return;

    const owner = OwnerRepository.get();
    const conv = ConversationRepository.ensureForJid(ctx.incoming.jid, owner.default_mode);
    ctx.conversation = conv;
    ctx.mode = owner.default_mode;
    ctx.conversationTakenOver = conv.taken_over;

    // Exclude pesan IN yang baru disimpan — disajikan terpisah ke prompt.
    ctx.history = MessageRepository.listByConversation(conv.id, config.pipeline.historyMessages)
      .filter((m) => m.id !== ctx.inMessageRowId);

    ConversationRepository.touch(conv.id);
  }
}
