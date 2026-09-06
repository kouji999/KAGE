// VoiceClient — TTS via OpenRouter /audio/speech (VERIFIED empirik 2026-09-06).
// deepgram/flux-tts:free TIDAK bisa lewat chat/completions (400 eksplisit dari server).
// Request: POST {base}/audio/speech {model, input, voice, response_format} → binary mp3.
// Kontrak: TIDAK PERNAH throw. Gagal dalam bentuk apa pun → null, caller fallback teks.

import { config } from '../../config/index.js';
import { childLogger } from '../../config/logger.js';
import { LlmUsageRepository } from '../../storage/index.js';

const log = childLogger('voice');

/** Buffer audio < ini dianggap bukan audio valid (error page / hening). */
const MIN_AUDIO_BYTES = 512;

export class VoiceClient {
  /**
   * Sintesis teks → Buffer mp3. Return null jika disabled, teks kosong, atau error apa pun.
   */
  async synthesize(text: string): Promise<Buffer | null> {
    try {
      if (!config.voice.enabled) return null;
      const clipped = text.trim().slice(0, config.voice.maxChars);
      if (clipped === '') return null;

      const res = await fetch(`${config.voice.baseUrl}/audio/speech`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.voice.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.voice.model,
          input: clipped,
          voice: config.voice.voiceName,
          response_format: config.voice.format,
        }),
        signal: AbortSignal.timeout(config.voice.timeoutMs),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        log.warn({ status: res.status, body: body.slice(0, 300) }, 'tts api error');
        return null;
      }

      const audio = Buffer.from(await res.arrayBuffer());
      if (audio.length < MIN_AUDIO_BYTES) {
        log.warn({ bytes: audio.length }, 'tts audio terlalu kecil — anggap gagal');
        return null;
      }

      // chars in = teks sumber; "chars out" = byte audio hasil (proxy volume)
      LlmUsageRepository.add('tts', config.voice.model, clipped.length, audio.length, 0);
      log.debug({ bytes: audio.length, chars: clipped.length }, 'tts ok');
      return audio;
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'tts failed — caller should fallback to text',
      );
      return null;
    }
  }
}

export const voice = new VoiceClient();
