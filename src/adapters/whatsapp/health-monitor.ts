// Session health monitor (T5). Owns reconnection policy: backoff schedule, attempt caps,
// and session_state persistence. The provider only reports — this decides what happens next.

import { config } from '../../config/index.js';
import { childLogger } from '../../config/logger.js';
import type { SessionState } from '../../domain/entities.js';
import type { ConnectionEvent, WhatsAppProvider } from '../../domain/whatsapp-provider.js';

const log = childLogger('health');

export type HealthEventType = 'connected' | 'reconnecting' | 'off' | 'logged_out';

export interface HealthEvent {
  type: HealthEventType;
  attempts: number;
}

/** Structural view of the session repository — no import of the storage lane needed. */
export interface SessionRepositoryLike {
  get(): SessionState;
  update(patch: {
    status?: 'connected' | 'disconnected' | 'off';
    lastConnectedAt?: string;
    reconnectCount?: number;
  }): void;
  incrementReconnect(): void;
}

export class HealthMonitor {
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  constructor(
    private readonly provider: WhatsAppProvider,
    private readonly sessionRepo: SessionRepositoryLike,
    private readonly onEvent?: (ev: HealthEvent) => void,
  ) {}

  /** Subscribe once; call before (or right after) provider.connect(). */
  start(): void {
    if (this.started) {
      log.warn('start() called on already-started monitor — ignored');
      return;
    }
    this.started = true;
    this.provider.onConnectionUpdate((ev) => this.handleConnectionEvent(ev));
    log.debug(
      { maxAttempts: config.resilience.reconnectMaxAttempts },
      'health monitor started',
    );
  }

  stop(): void {
    this.clearTimer();
    this.started = false;
    log.debug('health monitor stopped');
  }

  getAttempts(): number {
    return this.attempts;
  }

  // -------------------------------------------------------------------------
  // Connection event policy
  // -------------------------------------------------------------------------

  private handleConnectionEvent(ev: ConnectionEvent): void {
    switch (ev.status) {
      case 'connected': {
        this.clearTimer();
        this.attempts = 0;
        // reconnectCount is a historical counter — incrementReconnect keeps it, we don't reset it here.
        this.sessionRepo.update({
          status: 'connected',
          lastConnectedAt: new Date().toISOString(),
        });
        log.info('session connected — reconnect attempts reset');
        this.emit({ type: 'connected', attempts: 0 });
        break;
      }

      case 'disconnected': {
        // QR pairing wait (statusCode 408 "QR refs attempts ended") BUKAN kegagalan
        // jaringan — itu kondisi menunggu scan. Reset budget, reconnect tanpa
        // menghabiskan hitungan, supaya pairing window tidak mengunci sistem OFF.
        if (ev.reason !== undefined && /QR refs/i.test(ev.reason)) {
          this.clearTimer();
          this.attempts = 0;
          const qrBackoffMs = 2_000;
          this.timer = setTimeout(() => {
            this.timer = null;
            log.info('QR expired — re-issuing connection for fresh QR');
            this.provider
              .connect()
              .catch((err: unknown) =>
                log.warn({ err: err instanceof Error ? err.message : String(err) }, 'QR re-connect failed'),
              );
          }, qrBackoffMs);
          this.emit({ type: 'reconnecting', attempts: 0 });
          break;
        }

        const maxAttempts = config.resilience.reconnectMaxAttempts;
        if (this.attempts >= maxAttempts) {
          this.clearTimer();
          this.sessionRepo.update({ status: 'off' });
          log.error(
            { attempts: this.attempts, maxAttempts },
            'reconnect limit reached — session marked OFF',
          );
          this.emit({ type: 'off', attempts: this.attempts });
          break;
        }

        this.attempts += 1;
        this.sessionRepo.incrementReconnect();
        const backoffMs = Math.min(1000 * 2 ** (this.attempts - 1), 60_000);
        this.clearTimer();
        this.timer = setTimeout(() => {
          this.timer = null;
          log.info({ attempt: this.attempts }, 'reconnect attempt starting');
          this.provider
            .connect()
            .then(() => {
              log.debug({ attempt: this.attempts }, 'reconnect attempt issued');
            })
            .catch((err: unknown) => {
              log.warn(
                { err: err instanceof Error ? err.message : String(err), attempt: this.attempts },
                'reconnect attempt failed — scheduling next',
              );
              // connect() failed before any socket existed → no 'close' event will come.
              // Re-enter policy so backoff/attempt accounting stays intact.
              this.handleConnectionEvent({
                status: 'disconnected',
                reconnectCount: ev.reconnectCount,
                reason: 'reconnect attempt failed',
              });
            });
        }, backoffMs);
        log.info(
          { attempt: this.attempts, backoffMs, maxAttempts },
          'disconnected — reconnect scheduled with backoff',
        );
        this.emit({ type: 'reconnecting', attempts: this.attempts });
        break;
      }

      case 'logged_out': {
        this.clearTimer();
        this.attempts = 0;
        this.sessionRepo.update({ status: 'off' });
        log.error(
          { reason: ev.reason },
          `session logged out — delete auth folder ${config.authDir} and re-auth via QR`,
        );
        this.emit({ type: 'logged_out', attempts: this.attempts });
        break;
      }

      case 'qr': {
        log.debug('QR issued — waiting for scan (no reconnect policy change)');
        break;
      }

      case 'connecting': {
        log.debug('connection in progress');
        break;
      }

      default: {
        log.debug({ status: String(ev.status) }, 'unhandled provider status');
        break;
      }
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private emit(ev: HealthEvent): void {
    try {
      this.onEvent?.(ev);
    } catch (err) {
      log.error({ err }, 'health event callback threw');
    }
  }
}
