// KAGE bootstrap (T20): config → DB → provider → health monitor → queue → pipeline → API.
// Alur: Baileys message → pipeline 10 stage → safety-gated send / approval / hold.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from './config/index.js';
import { childLogger } from './config/logger.js';
import { MessageRepository, OwnerRepository, SessionRepository, initDb } from './storage/index.js';
import { createBaileysProvider } from './adapters/whatsapp/baileys-provider.js';
import { HealthMonitor, type HealthEvent } from './adapters/whatsapp/health-monitor.js';
import { notifier } from './core/notify/notifier.js';
import { RateLimiter, SendQueue } from './queue/index.js';
import { createPipelineContext, Pipeline } from './core/pipeline/pipeline.js';
import { MessageStage } from './core/pipeline/message.js';
import { ContactStage } from './core/pipeline/contact.js';
import { ContextStage } from './core/pipeline/context.js';
import { ClassifyStage } from './core/pipeline/classify.js';
import { RelationshipStage } from './core/pipeline/relationship.js';
import { MemoryStage } from './core/pipeline/memory.js';
import { GenerateStage } from './core/pipeline/generate.js';
import { SafetyStage } from './core/pipeline/safety.js';
import { SendStage } from './core/pipeline/send.js';
import { startApiServer } from './api/server.js';
import type { Message } from './domain/entities.js';
import type { ApiDeps } from './api/routes.js';

const log = childLogger('bootstrap');

async function main(): Promise<void> {
  // Single-instance lock — DUA instance share auth dir = prekeys kekonsumsi dobel
  // → Signal session korup (Bad MAC) → DM tidak terdekripsi. Hard-learned lesson.
  acquireInstanceLock();

  log.info({ db: config.dbPath, auth: config.authDir }, 'KAGE starting');

  // 1. DB + migrations
  initDb();

  // 2. WhatsApp transport (Baileys di balik WhatsAppProvider)
  const provider = createBaileysProvider();

  // 3. Health monitor — owns reconnect policy + graceful OFF (T5).
  //    SessionRepository statics di-adapt ke SessionRepositoryLike (instance shape).
  const healthMonitor = new HealthMonitor(
    provider,
    {
      get: () => SessionRepository.get(),
      update: (patch) => SessionRepository.update(patch),
      incrementReconnect: () => SessionRepository.incrementReconnect(),
    },
    (ev) => onHealthEvent(ev),
  );

  // 4. Send queue — rate limiting + retry + voice-first (T6)
  const queue = new SendQueue({
    provider,
    messageRepo: MessageRepository,
    rateLimiter: new RateLimiter(),
  });

  // 5. Pipeline — LATENSI-optimized: classify (gabungan intent+strategy, 1 LLM call)
  // → generate (1 LLM call) → safety (rule-first, LLM verify cuma MEDIUM).
  const pipeline = new Pipeline(
    new MessageStage(),
    new ContactStage(),
    new ContextStage(),
    new ClassifyStage(),
    new RelationshipStage(),
    new MemoryStage(),
    new GenerateStage(),
    new SafetyStage(),
    new SendStage({ queue }),
  );

  // 6. Incoming message → pipeline
  provider.onMessage((msg) => {
    void pipeline
      .run(createPipelineContext(msg))
      .catch((err: unknown) =>
        log.error({ err: err instanceof Error ? err.message : String(err) }, 'pipeline run failed'),
      );
  });

  // 7. Message status tracking: sent/delivered/read dari Baileys → DB (T19)
  provider.onMessageStatus((update) => {
    try {
      const row = MessageRepository.getByWaId(update.waMessageId);
      if (row && row.status !== update.status) {
        MessageRepository.updateStatus(row.id, update.status);
        log.debug({ waMessageId: update.waMessageId, status: update.status }, 'status updated');
      }
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'status update failed');
    }
  });

  // 8. Owner API + panel (T16)
  const apiDeps: ApiDeps = {
    provider,
    queue,
    healthMonitor: { getAttempts: () => healthMonitor.getAttempts() },
  };
  await startApiServer(apiDeps, (url) => {
    log.info(`${url} — owner panel + API siap`);
  });

  // 9. Health monitor aktif SEBELUM connect supaya event pertama ter-handle
  healthMonitor.start();

  // 10. T19 — boot retry: pending/failed dari crash sebelumnya. Jalan sekali pada
  // event 'connected' pertama; hormati mode OFF (jangan kirim saat OFF).
  let retryScanDone = false;
  const bootRetry = (): void => {
    if (retryScanDone) return;
    retryScanDone = true;
    try {
      if (OwnerRepository.get().default_mode === 'OFF') {
        log.info('mode OFF — boot retry dilewati');
        return;
      }
      const retryable: Message[] = MessageRepository.getRetryable();
      // SAFETY: boot retry HANYA ke JID yang pernah mengirim pesan masuk.
      // Mencegah data test/sampah terkirim ke nomor asing atas nama owner.
      const knownJids = new Set(
        MessageRepository.listIncomingJids().map((r) => r.contact_jid),
      );
      const safe = retryable.filter((m) => knownJids.has(m.contact_jid));
      const skipped = retryable.length - safe.length;
      if (skipped > 0) {
        log.warn({ skipped }, 'boot retry: dilewati (jid tidak pernah kirim pesan masuk)');
      }
      for (const m of safe) {
        void queue
          .enqueueSend({
            conversationId: m.conversation_id,
            contactJid: m.contact_jid,
            body: m.body,
            riskLevel: m.risk_level ?? 'LOW',
            messageId: m.id,
          })
          .catch((err: unknown) =>
            log.warn(
              { msgId: m.id, err: err instanceof Error ? err.message : String(err) },
              'boot retry enqueue gagal',
            ),
          );
      }
      if (retryable.length > 0) log.info({ count: retryable.length }, 'boot retry di-enqueue');
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'boot retry scan gagal');
    }
  };
  provider.onConnectionUpdate((ev) => {
    if (ev.status === 'connected') bootRetry();
  });

  // 11. Connect — QR print ke terminal saat menunggu scan
  await provider.connect().catch((err: unknown) => {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      'connect gagal saat boot — API tetap hidup; cek /api/v1/session/qr atau hapus folder auth untuk re-pair',
    );
  });

  log.info(`KAGE siap. Panel: http://${config.api.host}:${config.api.port}`);
}

function onHealthEvent(ev: HealthEvent): void {
  switch (ev.type) {
    case 'off':
      notifier.notify('session_off', { attempts: ev.attempts, reason: 'reconnect limit' });
      break;
    case 'logged_out':
      notifier.notify('session_off', {
        attempts: ev.attempts,
        reason: 'logged out — perlu QR ulang',
      });
      break;
    case 'reconnecting':
      log.debug({ attempts: ev.attempts }, 'health: reconnecting');
      break;
    default:
      break;
  }
}

/** Lock file: hanya 1 instance KAGE boleh jalan. Lock dilihat pada startup. */
function acquireInstanceLock(): void {
  const lockFile = path.join(config.dataDir, 'kage.lock');
  if (existsSync(lockFile)) {
    try {
      const pid = Number(readFileSync(lockFile, 'utf8').trim());
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
        // cek proses masih hidup
        try {
          process.kill(pid, 0);
          console.error(
            `KAGE sudah jalan (PID ${pid}). Tutup instance itu dulu, atau kill: taskkill /PID ${pid} /F`,
          );
          process.exit(2);
        } catch {
          // PID mati — lock basi, ambil alih
        }
      }
    } catch {
      // lock file corrupt — ambil alih
    }
  }
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(lockFile, String(process.pid));
  const release = (): void => {
    try {
      const cur = readFileSync(lockFile, 'utf8').trim();
      if (cur === String(process.pid)) unlinkSync(lockFile);
    } catch {
      // sudah dihapus / hilang — abaikan
    }
  };
  process.on('exit', release);
  process.on('SIGINT', release);
  process.on('SIGTERM', release);
}

main().catch((err: unknown) => {
  log.error({ err: err instanceof Error ? err.message : String(err) }, 'fatal bootstrap error');
  process.exit(1);
});

process.on('SIGINT', () => {
  log.info('SIGINT — shutdown');
  process.exit(0);
});
process.on('SIGTERM', () => {
  log.info('SIGTERM — shutdown');
  process.exit(0);
});
