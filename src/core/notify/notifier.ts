// T17 — Owner notification. Interface + default impl: log + DB (panel polls /notifications).
// Channel WA ke owner bisa ditambah tanpa ubah caller (implement Notifier baru).
import type { Notification } from '../../domain/entities.js';
import { NotificationRepository } from '../../storage/index.js';
import { childLogger } from '../../config/logger.js';

const log = childLogger('notifier');

export type NotificationKind = 'approval_pending' | 'session_off' | 'reconnect_failed' | 'takeover' | 'info';

export interface Notifier {
  notify(kind: NotificationKind, payload: Record<string, unknown>): void;
}

export class DbNotifier implements Notifier {
  notify(kind: NotificationKind, payload: Record<string, unknown>): void {
    try {
      NotificationRepository.add(kind, payload);
    } catch (err) {
      log.error({ err, kind }, 'failed to persist notification');
    }
    log.warn({ kind, ...payload }, `owner notification: ${kind}`);
  }
}

export const notifier: Notifier = new DbNotifier();

export function listUnreadNotifications(limit = 30): Notification[] {
  return NotificationRepository.listUnread(limit);
}
