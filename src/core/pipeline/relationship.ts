// Stage 'relationship' (T10e): ringkasan hubungan kontak. Tanpa LLM.

import type { PipelineContext, Stage } from './pipeline.js';

export class RelationshipStage implements Stage {
  readonly name = 'relationship';

  async execute(ctx: PipelineContext): Promise<void> {
    if (ctx.decision === 'skipped') return;

    const c = ctx.contact;
    const parts: string[] = [];

    const rel = c?.relationship;
    if (!rel || rel.type === 'unknown') {
      parts.push('Belum ada info hubungan, perlakukan sopan netral.');
    } else {
      parts.push(`Hubungan ${rel.type}, kedekatan ${rel.closeness}.`);
      if (rel.notes && rel.notes.trim() !== '') parts.push(rel.notes);
    }

    if (c && c.profile.preferences.length > 0) {
      parts.push(`Preferensi: ${c.profile.preferences.join(', ')}.`);
    }
    if (c && c.profile.notes && c.profile.notes.trim() !== '') {
      parts.push(c.profile.notes);
    }
    if (c && c.risk_notes && c.risk_notes.trim() !== '') {
      parts.push(`Catatan risiko: ${c.risk_notes}.`);
    }

    ctx.relationSummary = parts.join(' ');
  }
}
