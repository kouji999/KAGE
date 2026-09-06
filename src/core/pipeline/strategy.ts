// Stage 'strategy' (T10g): tentukan aksi strategis via LLM + fallback heuristik.
// 'delay'  → decision 'held'
// 'escalate' → riskLevel HIGH dini (paksa jalur approval)

import { childLogger } from '../../config/logger.js';
import { OwnerRepository } from '../../storage/index.js';
import { llm } from '../llm/client.js';
import { parseLlmJson } from './json.js';
import type { PipelineContext, Stage } from './pipeline.js';

const log = childLogger('pipeline:strategy');

const STRATEGIES = ['reply', 'delay', 'ask_detail', 'escalate'] as const;

const SYSTEM = `Kamu penentu strategi respons KAGE — asisten WhatsApp pribadi yang menjawab atas nama owner.
Dari intent, hubungan, riwayat, dan kepribadian owner, tentukan strategi untuk pesan masuk terakhir:
- reply: balas sekarang, singkat dan aman
- delay: jangan balas sekarang (pesan basa-basi, tengah malam, owner lagi sibuk, atau tidak penting)
- ask_detail: perlu balas tapi minta info/klarifikasi dulu
- escalate: JANGAN sentuh — butuh keputusan owner langsung (finansial, komitmen besar, konflik, topik sensitif)
Balas HANYA JSON: {"strategy":"<reply|delay|ask_detail|escalate>","reason":"<alasan singkat>"}`;

export class StrategyStage implements Stage {
  readonly name = 'strategy';

  async execute(ctx: PipelineContext): Promise<void> {
    if (ctx.decision === 'skipped' || ctx.decision === 'held') return;

    const lastFour = ctx.history
      .slice(-4)
      .map((m) => `[${m.direction === 'in' ? 'kontak' : 'owner'}] ${m.body}`)
      .join('\n');
    const character = OwnerRepository.get().personality_profile.character;

    const user = `Intent: ${ctx.intent}${ctx.intentNotes ? ` (${ctx.intentNotes})` : ''}\nHubungan: ${ctx.relationSummary}\nRiwayat:\n${lastFour || '(kosong)'}\nKepribadian owner: ${character}\n\nPesan masuk:\n${ctx.incoming.body}`;

    let strategy: string;
    let reason: string;

    try {
      const raw = await llm.chat(
        [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: user },
        ],
        { purpose: 'strategy', json: true, maxTokens: 1200, temperature: 0.3 },
      );

      const parsed = parseLlmJson<{ strategy?: unknown; reason?: unknown }>(raw);
      const s = typeof parsed?.strategy === 'string' ? parsed.strategy.trim().toLowerCase() : '';

      if ((STRATEGIES as readonly string[]).includes(s)) {
        strategy = s;
        reason = typeof parsed?.reason === 'string' ? parsed.reason.trim() : '';
      } else {
        strategy = fallbackStrategy(ctx.intent);
        reason = 'llm strategy tidak valid → heuristik';
      }
    } catch (err) {
      strategy = fallbackStrategy(ctx.intent);
      reason = `llm error → heuristik: ${err instanceof Error ? err.message : 'unknown'}`;
      log.debug({ jid: ctx.incoming.jid }, 'strategy fallback triggered');
    }

    if (strategy === 'delay') {
      // Guard naturalness: pertanyaan langsung TIDAK boleh di-delay — kontak menunggu
      // balasan, diam lebih lama = merusak ilusi owner aktif. Paksa reply.
      if (ctx.intent === 'question' || ctx.intent === 'casual' || ctx.intent === 'urgent') {
        log.info({ jid: ctx.incoming.jid, reason }, `llm pilih delay utk ${ctx.intent} — override ke reply`);
        strategy = 'reply';
      } else {
        ctx.strategy = 'delay';
        ctx.decision = 'held';
        ctx.decisionNote = `delay: ${reason}`;
        return;
      }
    }
    if (strategy === 'escalate') {
      // HIGH dini → jalur approval terpaksa, safety stage tidak akan menurunkan (max-only).
      ctx.riskLevel = 'HIGH';
      ctx.riskReasons.push(`strategi escalate: ${reason}`);
      ctx.decisionNote = `escalate: ${reason}`;
    }
    ctx.strategy = strategy;
  }
}

function fallbackStrategy(intent: string): string {
  if (intent === 'money' || intent === 'commitment' || intent === 'conflict') return 'escalate';
  if (intent === 'question') return 'reply';
  return 'reply';
}
