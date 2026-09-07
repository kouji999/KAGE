// Stage 'intent' (T10d): klasifikasi intent via LLM (JSON) + fallback heuristik regex.

import { llm } from '../llm/client.js';
import { parseLlmJson } from './json.js';
import type { PipelineContext, Stage } from './pipeline.js';

const INTENTS = [
  'question',
  'casual',
  'commitment',
  'conflict',
  'money',
  'urgent',
  'meeting',
  'favor',
  'media',
  'other',
] as const;
type Intent = (typeof INTENTS)[number];

const SYSTEM = `Kamu pengklasifikasi intent pesan WhatsApp (bahasa Indonesia).
Tentukan TEPAT SATU intent untuk pesan masuk terakhir dari daftar ini:
- question: bertanya sesuatu
- casual: sapaan, basa-basi, obrolan ringan
- commitment: janji, ajakan, jadwal, keikutsertaan
- conflict: konflik, kemarahan, debat, tegang
- money: uang, transfer, tagihan, harga, pinjaman
- urgent: mendesak, butuh respons cepat
- meeting: ketemu, rapat, datang ke acara
- favor: minta tolong
- media: pengiriman gambar/dokumen/file
- other: lainnya

Bahasa: kontak bisa pakai bahasa gaul/slang Indonesia (gue/lo, wkwk, gas, otw, mager, gblk, njir, cuy, bro, santuy, bet, nongki, gercep, ygy, gapapa, sry, plis, dll), campur bahasa daerah (jancuk, anjay, kuy, euy), campur English ringan, atau typo chat umum (yg, gmn, gk, dlu, udh, bsk, km, kmu, sy, aq). Pahami MAKNAnya dulu baru klasifikasi — jangan biarkan slang/typo menyesatkan intent.
Balas HANYA JSON: {"intent":"<kategori>","note":"<alasan singkat, max 15 kata>"}`;

export class IntentStage implements Stage {
  readonly name = 'intent';

  async execute(ctx: PipelineContext): Promise<void> {
    if (ctx.decision === 'skipped') return;

    const history = ctx.history
      .slice(-6)
      .map((m) => `[${m.direction === 'in' ? 'kontak' : 'owner'}] ${m.body}`)
      .join('\n');

    const user = `Kontak: ${ctx.contact?.name || '(tanpa nama)'} (${
      ctx.contact?.relationship.type ?? 'unknown'
    })\n\nRiwayat terakhir:\n${history || '(kosong)'}\n\nPesan masuk:\n${ctx.incoming.body}\n\nCatatan: pesan dalam kurung siku seperti [mengirim gambar] / [mengirim voice note] berarti kontak mengirim MEDIA tanpa teks — pilih intent yang wajar untuk sapaan/pesan ringan, bukan error.`;

    try {
      const raw = await llm.chat(
        [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: user },
        ],
        { purpose: 'intent', json: true, maxTokens: 1200, temperature: 0.2 },
      );

      const parsed = parseLlmJson<{ intent?: unknown; note?: unknown }>(raw);
      const intent = typeof parsed?.intent === 'string' ? parsed.intent.trim().toLowerCase() : '';

      if ((INTENTS as readonly string[]).includes(intent)) {
        ctx.intent = intent;
        ctx.intentNotes = typeof parsed?.note === 'string' ? parsed.note.trim() : '';
        return;
      }
      ctx.intent = heuristicIntent(ctx.incoming.body);
      ctx.intentNotes = 'llm intent tidak valid → heuristik';
    } catch (err) {
      // budget/network/parse gagal → jangan matikan pipeline
      ctx.intent = heuristicIntent(ctx.incoming.body);
      ctx.intentNotes = `heuristik fallback: ${err instanceof Error ? err.message : 'llm error'}`;
    }
  }
}

function heuristicIntent(body: string): Intent {
  if (/transfer|bayar|uang|saldo|harga|tagih/i.test(body)) return 'money';
  if (/janji|ikut|hadir|besok|nanti|schedule|jumat|senin/i.test(body)) return 'commitment';
  if (/\?\s*$/.test(body)) return 'question';
  return 'casual';
}
