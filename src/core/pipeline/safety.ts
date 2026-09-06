// Stage 'safety' (T10i): klasifikasi risiko. Rule-based konservatif DULU,
// LLM verification best-effort setelahnya — final = max(rule, llm, existing).
// Eskalasi saja, tidak pernah downgrade.

import { childLogger } from '../../config/logger.js';
import type { RiskLevel } from '../../domain/entities.js';
import { MessageRepository } from '../../storage/index.js';
import { llm } from '../llm/client.js';
import { parseLlmJson } from './json.js';
import type { PipelineContext, Stage } from './pipeline.js';

const log = childLogger('pipeline:safety');

const HIGH_INTENTS = new Set(['commitment', 'money', 'conflict']);
const MEDIUM_INTENTS = new Set(['question', 'meeting', 'favor', 'urgent']);

/** Kata/frasa berisiko di body ATAU draft (conservative default per spec). */
const RISK_WORD_RE =
  /transfer|bayar|uang|harga|kirim (uang|file)|pinjam|utang|janji|ikrar|kontrak|deal|surender|maaf (kan|at)? (se|ka)lama|putus|sampai jumpa|selamat tinggal|hancur|benci|marah|protes|lawyer|polisi|pidana|pid/i;

/** Draft yang memuat janji/komitmen atas nama owner. */
const PROMISE_RE = /janji|akan (kamu|aku) (bayar|kirim|antar|datang|hadir)/i;

const RISK_RANK: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

const VERIFY_SYSTEM = `Kamu reviewer keamanan pesan WhatsApp untuk KAGE.
Nilai risiko MENGIRIM draft ini ke kontak:
- LOW: aman, basa-basi/informasi netral
- MEDIUM: perlu perhatian (pertanyaan, jadwal, minta tolong ringan)
- HIGH: komitmen finansial/janji/kontrak/konflik/emosional/irreversible
Balas HANYA JSON: {"risk":"LOW|MEDIUM|HIGH","reasons":["<alasan singkat>"]}`;

export class SafetyStage implements Stage {
  readonly name = 'safety';

  async execute(ctx: PipelineContext): Promise<void> {
    if (ctx.decision === 'skipped' || ctx.decision === 'held') return;

    const reasons: string[] = [];
    let ruleRisk: RiskLevel = 'LOW';

    // --- HIGH rules ---
    if (HIGH_INTENTS.has(ctx.intent)) {
      ruleRisk = 'HIGH';
      reasons.push(`intent=${ctx.intent} (area sensitif)`);
    }
    if (RISK_WORD_RE.test(ctx.incoming.body)) {
      ruleRisk = 'HIGH';
      reasons.push('kata berisiko di pesan masuk');
    }
    if (ctx.draft !== '' && RISK_WORD_RE.test(ctx.draft)) {
      ruleRisk = 'HIGH';
      reasons.push('kata berisiko di draft');
    }
    if (ctx.draft !== '' && PROMISE_RE.test(ctx.draft)) {
      ruleRisk = 'HIGH';
      reasons.push('draft memuat janji/komitmen');
    }
    if (ctx.contact?.relationship.closeness === 'distant' && ctx.intent === 'commitment') {
      ruleRisk = 'HIGH';
      reasons.push('komitmen ke kontak distant');
    }

    // --- MEDIUM rules (hanya kalau belum HIGH) ---
    if (ruleRisk !== 'HIGH') {
      if (MEDIUM_INTENTS.has(ctx.intent)) {
        ruleRisk = 'MEDIUM';
        reasons.push(`intent=${ctx.intent}`);
      }
      if (ctx.contact && ctx.contact.risk_notes.trim() !== '') {
        ruleRisk = 'MEDIUM';
        reasons.push('kontak punya catatan risiko');
      }
      if (!ctx.contact || ctx.contact.relationship.type === 'unknown') {
        ruleRisk = 'MEDIUM';
        reasons.push('hubungan belum dikenal');
      }
    }

    // existing ctx.riskLevel ikut dihitung — strategy 'escalate' bisa sudah set HIGH di sini.
    let finalRisk = maxRisk(ruleRisk, ctx.riskLevel);

    // --- LLM verification (best-effort, only escalate up) ---
    try {
      const user = `Kontak: ${ctx.contact?.name || '(tanpa nama)'}\nHubungan: ${ctx.relationSummary}\nIntent: ${ctx.intent}\n\nPesan masuk:\n${ctx.incoming.body}\n\nDraft balasan:\n${ctx.draft || '(kosong)'}`;
      const raw = await llm.chat(
        [
          { role: 'system', content: VERIFY_SYSTEM },
          { role: 'user', content: user },
        ],
        { purpose: 'safety', json: true, maxTokens: 1200, temperature: 0 },
      );

      const parsed = parseLlmJson<{ risk?: unknown; reasons?: unknown }>(raw);
      const llmRisk = normalizeRisk(parsed?.risk);
      if (llmRisk) {
        if (RISK_RANK[llmRisk] > RISK_RANK[finalRisk]) {
          reasons.push(`llm eskalasi ke ${llmRisk}`);
        }
        finalRisk = maxRisk(finalRisk, llmRisk);
        if (Array.isArray(parsed?.reasons)) {
          for (const r of parsed.reasons) {
            if (typeof r === 'string' && r.trim() !== '') reasons.push(`llm: ${r.trim()}`);
          }
        }
      }
    } catch (err) {
      // LLM error → hasil rule dipakai apa adanya
      log.debug(
        { jid: ctx.incoming.jid, err: err instanceof Error ? err.message : String(err) },
        'safety llm verify unavailable — rule result stands',
      );
    }

    ctx.riskLevel = finalRisk;
    ctx.riskReasons = reasons;

    if (ctx.inMessageRowId > 0) {
      MessageRepository.updateRisk(ctx.inMessageRowId, finalRisk);
    }
  }
}

function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_RANK[a] >= RISK_RANK[b] ? a : b;
}

function normalizeRisk(v: unknown): RiskLevel | null {
  if (typeof v !== 'string') return null;
  const u = v.trim().toUpperCase();
  return u === 'LOW' || u === 'MEDIUM' || u === 'HIGH' ? u : null;
}
