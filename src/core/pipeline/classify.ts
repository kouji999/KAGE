// Stage 'classify' — SATU panggilan LLM gabungan intent + strategy (dulu 2 call terpisah;
// digabung demi latensi: 5 call berantai → 2 call critical path).
// Fallback heuristik penuh kalau LLM gagal.

import { childLogger } from '../../config/logger.js';
import { OwnerRepository } from '../../storage/index.js';
import { llm } from '../llm/client.js';
import { parseLlmJson } from './json.js';
import type { PipelineContext, Stage } from './pipeline.js';

const log = childLogger('pipeline:classify');

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

const STRATEGIES = ['reply', 'delay', 'ask_detail', 'escalate'] as const;

const SYSTEM = `Kamu analisis pesan WhatsApp masuk (bahasa Indonesia) untuk KAGE — asisten AI yang menjawab atas nama owner. Tentukan DUA hal sekaligus untuk pesan masuk terakhir:

1. INTENT — TEPAT SATU dari: question (bertanya), casual (sapaan/basa-basi), commitment (janji/ajakan/jadwal/keikutsertaan), conflict (konflik/kemarahan/debat), money (uang/transfer/tagihan/pinjaman), urgent (mendesak), meeting (ketemu/rapat/datang), favor (minta tolong), media (kirim gambar/dokumen), other.

2. STRATEGY — TEPAT SATU dari:
- reply: balas sekarang, singkat dan aman
- delay: jangan balas sekarang (basa-basi di momen salah, tengah malam, tidak penting)
- ask_detail: balas tapi minta klarifikasi/info dulu
- escalate: jangan disentuh — butuh keputusan owner LANGSUNG (uang, pinjaman, komitmen besar, konflik, topik sensitif)

Aturan strategy: pertanyaan/casual/urgent → JANGAN delay, minimal reply. money/commitment/conflict → escalate.
Bahasa: kontak bisa pakai slang/gaul (wkwk, gas, otw, mager, njir, cuy, santuy, kuy, gmn, bgt, yg, udh, dlu) atau typo — pahami maknanya dulu.
Balas HANYA JSON: {"intent":"...","note":"maksud kontak, max 10 kata","strategy":"...","reason":"alasan singkat"}`;

export class ClassifyStage implements Stage {
  readonly name = 'classify';

  async execute(ctx: PipelineContext): Promise<void> {
    if (ctx.decision === 'skipped') return;

    const history = ctx.history
      .slice(-6)
      .map((m) => `[${m.direction === 'in' ? 'kontak' : 'owner'}] ${m.body}`)
      .join('\n');
    const character = OwnerRepository.get().personality_profile.character;

    const user = `Kontak: ${ctx.contact?.name || '(tanpa nama)'} (${
      ctx.contact?.relationship.type ?? 'unknown'
    })\nHubungan: ${ctx.relationSummary || 'belum dikenal'}\nKepribadian owner: ${character.slice(0, 120)}\n\nRiwayat terakhir:\n${history || '(kosong)'}\n\nPesan masuk:\n${ctx.incoming.body}\n\n(Catatan: "[mengirim gambar]" dll = kontak kirim media tanpa caption.)`;

    let intent = '';
    let strategy = '';
    try {
      const raw = await llm.chat(
        [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: user },
        ],
        { purpose: 'classify', json: true, maxTokens: 1200, temperature: 0.2 },
      );
      const parsed = parseLlmJson<{
        intent?: unknown;
        note?: unknown;
        strategy?: unknown;
        reason?: unknown;
      }>(raw);

      const i = typeof parsed?.intent === 'string' ? parsed.intent.trim().toLowerCase() : '';
      intent = (INTENTS as readonly string[]).includes(i) ? i : heuristicIntent(ctx.incoming.body);
      ctx.intentNotes = typeof parsed?.note === 'string' ? parsed.note.trim() : '';

      const s = typeof parsed?.strategy === 'string' ? parsed.strategy.trim().toLowerCase() : '';
      strategy = (STRATEGIES as readonly string[]).includes(s) ? s : fallbackStrategy(intent);
      ctx.decisionNote = typeof parsed?.reason === 'string' ? parsed.reason.trim() : '';
    } catch (err) {
      intent = heuristicIntent(ctx.incoming.body);
      strategy = fallbackStrategy(intent);
      ctx.intentNotes = `heuristik fallback: ${err instanceof Error ? err.message : 'llm error'}`;
      log.debug({ jid: ctx.incoming.jid }, 'classify fallback triggered');
    }

    ctx.intent = intent;

    // Guard naturalness: delay tidak boleh untuk yang menunggu jawaban
    if (strategy === 'delay' && ['question', 'casual', 'urgent'].includes(intent)) {
      log.info({ jid: ctx.incoming.jid }, `llm delay utk ${intent} — override reply`);
      strategy = 'reply';
    }

    if (strategy === 'delay') {
      ctx.strategy = 'delay';
      ctx.decision = 'held';
      ctx.decisionNote = `delay: ${ctx.decisionNote}`;
      return;
    }
    if (strategy === 'escalate') {
      ctx.riskLevel = 'HIGH';
      ctx.riskReasons.push(`strategi escalate: ${ctx.decisionNote}`);
    }
    ctx.strategy = strategy;
  }
}

function heuristicIntent(body: string): string {
  if (/transfer|bayar|uang|saldo|harga|tagih|pinjam|pinjem|utang|dpn\b/i.test(body)) return 'money';
  if (/janji|ikut|hadir|kuy|gas\s|main|nongkrong|ketemu|jumat|senin|besok/i.test(body)) return 'commitment';
  if (/\?\s*$/.test(body)) return 'question';
  return 'casual';
}

function fallbackStrategy(intent: string): string {
  if (intent === 'money' || intent === 'commitment' || intent === 'conflict') return 'escalate';
  return 'reply';
}
