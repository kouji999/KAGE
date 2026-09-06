// Stage 'contact' (T10b): upsert kontak pengirim.

import { ContactRepository } from '../../storage/index.js';
import type { PipelineContext, Stage } from './pipeline.js';

export class ContactStage implements Stage {
  readonly name = 'contact';

  async execute(ctx: PipelineContext): Promise<void> {
    if (ctx.decision === 'skipped') return;
    // pushName dari WA (display name kontak) — penting utk JID @lid yang tanpa nomor.
    ctx.contact = ContactRepository.upsertByJid(ctx.incoming.jid, ctx.incoming.pushName ?? '');
  }
}
