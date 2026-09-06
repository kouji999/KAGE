// SendQueue (T15): antrean kirim dengan pacing global (p-queue), rate limit
// rolling-window per kontak, retry backoff eksponensial, voice-first + fallback teks.

import PQueue from 'p-queue';
import { config } from '../config/index.js';
import { childLogger } from '../config/logger.js';
import type { RiskLevel } from '../domain/entities.js';
import type { WhatsAppProvider } from '../domain/whatsapp-provider.js';
import {
  ConversationRepository,
  MessageRepository,
  OwnerRepository,
  RateLimitRepository,
} from '../storage/index.js';
import { voice } from '../core/llm/voice.js';

const log = childLogger('queue');

// ---------------------------------------------------------------------------
// RateLimiter — rolling window per JID, state di DB (tahan restart)
// ---------------------------------------------------------------------------

export class RateLimiter {
  /** true = masih boleh kirim ke jid ini. */
  check(jid: string): boolean {
    const st = RateLimitRepository.get(jid);
    if (!st) return true;
    const start = Date.parse(st.window_start);
    if (Number.isNaN(start)) return true;
    if (Date.now() - start > config.rate.windowMs) return true; // window kedaluwarsa → reset saat record
    return st.message_count < config.rate.maxPerWindow;
  }

  /** Catat 1 pesan terkirim; reset window kalau expired. */
  record(jid: string): void {
    const st = RateLimitRepository.get(jid);
    const start = st ? Date.parse(st.window_start) : Number.NaN;
    if (st && !Number.isNaN(start) && Date.now() - start <= config.rate.windowMs) {
      RateLimitRepository.set(jid, st.window_start, st.message_count + 1);
    } else {
      RateLimitRepository.set(jid, new Date().toISOString(), 1);
    }
  }
}

// ---------------------------------------------------------------------------
// SendQueue
// ---------------------------------------------------------------------------

export interface EnqueueSendInput {
  conversationId: number;
  contactJid: string;
  body: string;
  riskLevel: RiskLevel;
  /** reuse row existing (retry); kosong = buat pesan OUT baru status pending */
  messageId?: number;
  /**
   * Override preferensi voice per-pesan:
   *  true  = coba voice note (fallback teks kalau TTS gagal)
   *  false = teks murni
   *  undefined = ikut config.voice.mode
   */
  voice?: boolean;
}

export interface SendQueueDeps {
  provider: WhatsAppProvider;
  /** static class ref — di-inject supaya testable */
  messageRepo: typeof MessageRepository;
  rateLimiter: RateLimiter;
}

export class SendQueue {
  private readonly q: PQueue;

  constructor(private readonly deps: SendQueueDeps) {
    // pacing global: 1 concurrent + rate cap per window
    this.q = new PQueue({
      concurrency: 1,
      intervalCap: config.rate.maxPerWindow,
      interval: config.rate.windowMs,
    });
  }

  /** Enqueue pesan keluar. Row OUT dibuat di dalam task kalau belum ada messageId. */
  async enqueueSend(m: EnqueueSendInput): Promise<void> {
    await this.q.add(() => this.processSend(m, true));
  }

  /**
   * Kirim teks mentah (dipakai jalur approval: owner approve/edit → kirim).
   * Lewat jalur kirim yang sama (limiter + retry), risk default LOW
   * karena sudah atas persetujuan owner.
   */
  async enqueueRawText(
    jid: string,
    body: string,
    riskLevel: RiskLevel = 'LOW',
    voice?: boolean,
  ): Promise<void> {
    const conv = ConversationRepository.ensureForJid(jid, OwnerRepository.get().default_mode);
    await this.enqueueSend({ conversationId: conv.id, contactJid: jid, body, riskLevel, voice });
  }

  /**
   * @param allowDefer — kali pertama task jalan: boleh defer 1x saat rate limit;
   * setelah defer, tidak boleh defer lagi (max once → failed).
   */
  private async processSend(m: EnqueueSendInput, allowDefer: boolean): Promise<void> {
    const repo = this.deps.messageRepo;

    let msgId = m.messageId;
    if (msgId === undefined) {
      const row = repo.insert({
        waMessageId: '',
        conversationId: m.conversationId,
        contactJid: m.contactJid,
        direction: 'out',
        body: m.body,
        status: 'pending',
        riskLevel: m.riskLevel,
      });
      msgId = row.id;
    }

    // --- rate limit per kontak ---
    if (!this.deps.rateLimiter.check(m.contactJid)) {
      if (allowDefer) {
        log.warn({ jid: m.contactJid, msgId }, 'rate limited — defer sekali setelah window');
        setTimeout(() => {
          void this.q
            .add(() => this.processSend({ ...m, messageId: msgId }, false))
            .catch((err: unknown) =>
              log.error({ msgId, err: errMsg(err) }, 'deferred send task crashed'),
            );
        }, config.rate.windowMs);
        return;
      }
      log.error({ jid: m.contactJid, msgId }, 'rate limited kedua kali — mark failed');
      repo.updateStatus(msgId, 'failed');
      return;
    }
    this.deps.rateLimiter.record(m.contactJid);

    // --- kirim + retry ---
    try {
      await this.deliver(m.contactJid, m.body, m.voice);
      repo.updateStatus(msgId, 'sent');
      repo.incrementAttempt(msgId);
      log.info({ jid: m.contactJid, msgId, voice: m.voice ?? null }, 'message sent');
    } catch (err) {
      repo.incrementAttempt(msgId);
      const attempt = repo.getById(msgId)?.attempt ?? config.resilience.sendMaxAttempts;
      const message = errMsg(err);
      if (attempt < config.resilience.sendMaxAttempts) {
        const backoffMs = config.resilience.sendBackoffBaseMs * 2 ** (attempt - 1);
        log.warn({ msgId, attempt, backoffMs, err: message }, 'send failed — retry scheduled');
        setTimeout(() => {
          void this.q
            .add(() => this.processSend({ ...m, messageId: msgId }, true))
            .catch((retryErr: unknown) =>
              log.error({ msgId, err: errMsg(retryErr) }, 'retry send task crashed'),
            );
        }, backoffMs);
      } else {
        log.error({ msgId, attempt, err: message }, 'send failed after max attempts — mark failed');
        repo.updateStatus(msgId, 'failed');
      }
    }
  }

  /**
   * Voice-first sesuai override per-pesan → config; TTS gagal / voice-send gagal → fallback teks.
   */
  private async deliver(jid: string, body: string, voiceOverride?: boolean): Promise<void> {
    const wantVoice = voiceOverride ?? (config.voice.enabled && config.voice.mode !== 'text');
    if (wantVoice) {
      const audio = await voice.synthesize(body);
      if (audio) {
        try {
          await this.deps.provider.sendMessage({
            jid,
            body: audio.toString('base64'),
            asVoiceNote: true,
          });
          return;
        } catch (err) {
          log.warn({ jid, err: errMsg(err) }, 'voice send failed — fallback to text');
        }
      }
    }
    await this.deps.provider.sendMessage({ jid, body });
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
