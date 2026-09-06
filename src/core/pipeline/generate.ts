// Stage 'generate' (T10h): buat draft balasan via personality prompt.

import { childLogger } from '../../config/logger.js';
import { llm } from '../llm/client.js';
import { extractMemories } from './memory.js';
import { buildPersonalityPrompt } from '../personality/engine.js';
import type { PipelineContext, Stage } from './pipeline.js';

const log = childLogger('pipeline:generate');

const DRAFT_MAX_CHARS = 800;

const STRATEGY_INSTRUCTION: Record<string, string> = {
  reply: 'Balas pesan ini langsung.',
  ask_detail: 'Balas dengan meminta detail/klarifikasi dulu, singkat.',
  delay: 'Jangan balas sekarang.',
  escalate:
    'Pesan ini butuh owner. Jawab sangat netral dan tidak mengikat, atau evasif natural seperti orang sibuk.',
};

export class GenerateStage implements Stage {
  readonly name = 'generate';

  async execute(ctx: PipelineContext): Promise<void> {
    if (ctx.decision === 'skipped' || ctx.decision === 'held') return;

    const system = buildPersonalityPrompt();
    ctx.personality = system;

    const memoryBullets = ctx.memory.map((m) => `- (${m.type}) ${m.content}`).join('\n');
    const historyLines = ctx.history
      .slice(-8)
      .map((m) => `[${m.direction === 'in' ? 'kontak' : 'owner'}] ${m.body}`)
      .join('\n');
    const instruction = STRATEGY_INSTRUCTION[ctx.strategy] ?? 'Balas pesan ini.';

    const user = `Kontak: ${ctx.contact?.name || '(tanpa nama)'}\nHubungan: ${ctx.relationSummary}\n\nMemori tentang kontak:\n${memoryBullets || '(belum ada)'}\n\nRiwayat percakapan:\n${historyLines || '(belum ada)'}\n\nPesan terbaru dari kontak:\n${ctx.incoming.body}\n\nStrategi: ${ctx.strategy} — ${instruction}\n\nTulis balasanmu sekarang.`;

    try {
      const raw = await llm.chat(
        [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        { purpose: 'generate', maxTokens: 2000 },
      );

      const draft = cleanDraft(raw);
      if (draft === '') throw new Error('draft kosong setelah cleanup');
      if (isPlaceholderDraft(draft)) {
        throw new Error(`draft placeholder non-balasan ditolak: "${draft.slice(0, 60)}"`);
      }
      ctx.draft = draft;
    } catch (err) {
      // budget/network gagal → hold TANPA record pesan OUT.
      // Status held terekam di pipeline_result pesan IN (persist oleh send stage).
      ctx.decision = 'held';
      ctx.decisionNote = `LLM unavailable: ${err instanceof Error ? err.message : String(err)}`;
      log.warn({ jid: ctx.incoming.jid, note: ctx.decisionNote }, 'generate held');
      return;
    }

    await extractMemories(ctx.draft, ctx.incoming.jid);
  }
}

function cleanDraft(raw: string): string {
  let draft = raw.trim();
  // strip label leading ala "KAGE:" / "Bot:" / "Owner:"
  draft = draft.replace(/^(?:kage|bot|assistant|owner)\s*[:\-–—]\s*/i, '');
  // strip kutip pembungkus penuh
  if (draft.length >= 2 && draft.startsWith('"') && draft.endsWith('"')) {
    draft = draft.slice(1, -1);
  }
  draft = draft.trim();

  if (draft.length > DRAFT_MAX_CHARS) {
    // potong di batas kata terdekat
    const cut = draft.slice(0, DRAFT_MAX_CHARS);
    const lastSpace = cut.lastIndexOf(' ');
    draft = (lastSpace > DRAFT_MAX_CHARS / 2 ? cut.slice(0, lastSpace) : cut).trimEnd();
  }
  return draft;
}

/**
 * Placeholder non-balasan dari LLM (contoh nyata: "(tidak membalas — delay)")
 * TIDAK BOLEH terkirim ke kontak — kirim pesan meta = merusak ilusi owner.
 * Draft seperti ini → error → stage hold (tidak kirim apa-apa).
 */
const PLACEHOLDER_RE =
  /^\s*[(\[]?\s*(tidak membalas|tidak merespon|no reply|no response|delay|abai|ignore|meledak|—|\-)\b/i;

export function isPlaceholderDraft(draft: string): boolean {
  if (draft.trim().length < 5) return true;
  return PLACEHOLDER_RE.test(draft);
}
