// Stage 'memory' (T10f): load memori per kontak + ekstraksi memori pasca-generate.

import { config } from '../../config/index.js';
import { childLogger } from '../../config/logger.js';
import { MemoryRepository } from '../../storage/index.js';
import type { MemoryType } from '../../domain/entities.js';
import { llm } from '../llm/client.js';
import { parseLlmJson } from './json.js';
import type { PipelineContext, Stage } from './pipeline.js';

const log = childLogger('pipeline:memory');

export class MemoryStage implements Stage {
  readonly name = 'memory';

  async execute(ctx: PipelineContext): Promise<void> {
    if (ctx.decision === 'skipped') return;
    ctx.memory = MemoryRepository.listByJid(ctx.incoming.jid, config.pipeline.memoryPerContact);
  }
}

const EXTRACT_SYSTEM = `Kamu ekstraktor memori percakapan WhatsApp.
Dari teks balasan di bawah, ekstrak MAKSIMAL 2 memori jangka panjang yang BENAR-BENAR signifikan tentang pengirim: fakta personal (pekerjaan, domisili, keluarga), event (nikahan, pindahan), atau preferensi.
Abaikan basa-basi dan hal sementara. Kalau tidak ada yang signifikan, kembalikan array kosong.
Balas HANYA JSON: {"memories":[{"type":"fact|event|preference","content":"<satu kalimat singkat>"}]}`;

/**
 * Dipanggil generate stage SETELAH draft berhasil dibuat.
 * Gagal apa pun di-skip diam-diam — ekstraksi memori tidak boleh mengganggu alur.
 * Dedup ditangani MemoryRepository (content identik di-skip).
 */
export async function extractMemories(draft: string, contactJid: string): Promise<void> {
  try {
    const raw = await llm.chat(
      [
        { role: 'system', content: EXTRACT_SYSTEM },
        { role: 'user', content: draft },
      ],
      { purpose: 'memory', json: true, maxTokens: 1200, temperature: 0.1 },
    );

    const parsed = parseLlmJson<{ memories?: unknown }>(raw);
    if (!Array.isArray(parsed?.memories)) return;

    for (const item of parsed.memories.slice(0, 2)) {
      if (typeof item !== 'object' || item === null) continue;
      const rec = item as { type?: unknown; content?: unknown };
      const content = typeof rec.content === 'string' ? rec.content.trim() : '';
      if (content === '') continue;
      const type: MemoryType =
        rec.type === 'event' || rec.type === 'preference' || rec.type === 'fact'
          ? rec.type
          : 'fact';
      MemoryRepository.add(contactJid, type, content);
    }
  } catch (err) {
    log.debug(
      { jid: contactJid, err: err instanceof Error ? err.message : String(err) },
      'memory extraction skipped',
    );
  }
}
