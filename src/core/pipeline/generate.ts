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

    // Konteks media: pesan masuk bukan teks murni (gambar/voice/file tanpa caption).
    const mediaNote =
      ctx.incoming.kind === 'image'
        ? '(Kontak mengirim GAMBAR/sticker tanpa caption. Kamu TIDAK bisa melihat isinya. Jangan mengarang isi gambar. Respons natural datar: akur keberadaannya, mis. menyuruh jelaskan, atau "Oke." singkat.)'
        : ctx.incoming.kind === 'audio'
          ? '(Kontak mengirim VOICE NOTE. Kamu TIDAK bisa mendengarnya. Jangan mengarang isinya. Respons natural datar: mis. "Nanti aku dengar." atau minta ketik.)'
          : ctx.incoming.kind === 'unknown' && /^\[mengirim /.test(ctx.incoming.body)
            ? '(Kontak mengirim media/file tanpa caption. Kamu tidak bisa membukanya sekarang. Respons singkat datar: akur + evasif natural.)'
            : '';

    // Self-introduction: chat PERTAMA di percakapan ini → perkenalkan diri
    // sebagai asisten AI milik owner (owner lagi tidak aktif).
    const isFirstMessage = ctx.history.length === 0;
    const introNote = isFirstMessage
      ? '(PERCAKAPAN BARU — pesan pertama dari kontak ini. Sisipkan perkenalan singkat dan ramah di awal balasan: kamu asisten AI-nya, dia sedang tidak bisa membalas, kamu yang menggantikan sementara, dan ngobrol santai sama kamu boleh. Satu-dua kalimat saja, jangan bertele-tele, lalu tanggapi pesannya.)'
      : '';

    // Mirror bahasa kontak: pahami slang/gaul/typo/daerah, balas dengan register serupa.
    const langNote =
      '(Bahasa kontak mungkin slang/gaul/typo/bahasa daerah — pahami maknanya. ' +
      'Balas dengan gaya serupa tapi tetap jelas: kalau dia pakai "lo/gue" pakai "lo/gue", kalau formal pakai "kamu/aku". ' +
      'Boleh pakai slang ringan umum (gas, otw, gapapa, santuy) TANPA sok anak muda paksaan, tanpa singkatan berlebihan yang membingungkan.)';

    const user = `Kontak: ${ctx.contact?.name || '(tanpa nama)'}\nHubungan: ${ctx.relationSummary}\n\nMemori tentang kontak:\n${memoryBullets || '(belum ada)'}\n\nRiwayat percakapan:\n${historyLines || '(belum ada)'}\n\nPesan terbaru dari kontak:\n${ctx.incoming.body}${mediaNote ? '\n\n' + mediaNote : ''}${introNote ? '\n\n' + introNote : ''}\n\n${langNote}\n\nStrategi: ${ctx.strategy} — ${instruction}\n\nTulis balasanmu sekarang.`;

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

    extractMemories(ctx.draft, ctx.incoming.jid); // fire-and-forget, jangan tahan kirim
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

  // gaya chat santai: huruf kecil semua — CAPS utuh dipertahankan hanya untuk
  // tekanan emosional (kata >=3 huruf caps penuh, mis. "SERIUSSS??")
  draft = draft
    .split(/(\s+)/)
    .map((w) => {
      const core = w.replace(/[^\p{L}]/gu, '');
      const allCaps = core.length >= 3 && core === core.toUpperCase();
      return allCaps ? w : w.toLowerCase();
    })
    .join('');
  // zero emoji — strip emoji & pictograph (termasuk ZWJ sequences)
  draft = draft
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{1F1E6}-\u{1F1FF}]/gu, '')
    .replace(/  +/g, ' ')
    .trim();

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
