// Baileys transport adapter (T4). Implements WhatsAppProvider; core never touches Baileys directly.
// Reconnection is owned by HealthMonitor — this provider only reports lifecycle events.

import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import type {
  ConnectionState,
  MessageUpsertType,
  MessageUserReceiptUpdate,
  WAMessage,
  WAMessageUpdate,
  WASocket,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcodeTerminal from 'qrcode-terminal';

import { config } from '../../config/index.js';
import { childLogger } from '../../config/logger.js';
import type {
  ConnectionEvent,
  IncomingMessage,
  OutgoingMessage,
  ProviderStatus,
  WhatsAppProvider,
} from '../../domain/whatsapp-provider.js';

const log = childLogger('baileys');

export interface MessageStatusUpdate {
  waMessageId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
}

/**
 * Map proto.WebMessageInfo.Status (verified against WAProto enum in this Baileys version):
 * 0=ERROR, 1=PENDING, 2=SERVER_ACK, 3=DELIVERY_ACK, 4=READ, 5=PLAYED.
 * Note: DELIVERY_ACK(3)=delivered, READ(4)=read — NOT 2/3 as an earlier draft assumed.
 */
function mapWaStatus(status: number): MessageStatusUpdate['status'] | null {
  switch (status) {
    case 0:
      return 'failed';
    case 1:
      return null; // pending — nothing to report
    case 2:
      return 'sent'; // acknowledged by WA server
    case 3:
      return 'delivered'; // delivery ack on recipient device
    case 4:
    case 5:
      return 'read'; // READ / PLAYED
    default:
      return null;
  }
}

export class BaileysProvider implements WhatsAppProvider {
  private sock: WASocket | null = null;
  private status: ProviderStatus = 'off';
  private qrString: string | null = null;
  private reconnectCount = 0;

  private readonly messageHandlers: Array<(msg: IncomingMessage) => void> = [];
  private readonly connectionHandlers: Array<(ev: ConnectionEvent) => void> = [];
  private readonly statusHandlers: Array<(update: MessageStatusUpdate) => void> = [];

  async connect(): Promise<void> {
    if (this.status === 'logged_out') {
      throw new Error(
        `Session logged out. Delete auth folder ${config.authDir} and re-auth via QR.`,
      );
    }
    if (this.sock) {
      log.warn('connect() called while a socket already exists — ignored');
      return;
    }

    const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
    const { version } = await fetchLatestBaileysVersion();
    // Baileys is extremely chatty — route its internals to a silent pino, KAGE logs via childLogger.
    const silentPino = pino({ level: 'silent' });

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, silentPino),
      },
      logger: silentPino,
      browser: Browsers.ubuntu('KAGE'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });
    this.sock = sock;
    this.setStatus('connecting');
    log.info({ version, authDir: config.authDir }, 'socket created, connecting');

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update: Partial<ConnectionState>) =>
      this.handleConnectionUpdate(update),
    );
    sock.ev.on('messages.upsert', (payload: { messages: WAMessage[]; type: MessageUpsertType }) =>
      this.handleMessagesUpsert(payload),
    );
    sock.ev.on('messages.update', (updates: WAMessageUpdate[]) =>
      this.handleMessagesUpdate(updates),
    );
    // 'message-status-update' does not exist in Baileys 6.7.24 (verified against BaileysEventMap
    // and runtime sources). Receipts arrive via typed 'message-receipt.update' instead.
    sock.ev.on('message-receipt.update', (receipts: MessageUserReceiptUpdate[]) =>
      this.handleMessageReceipts(receipts),
    );
  }

  async disconnect(): Promise<void> {
    const sock = this.sock;
    this.sock = null;
    if (sock) {
      try {
        await sock.logout();
      } catch (err) {
        log.warn({ err }, 'logout() failed — forcing socket end');
        try {
          sock.end(undefined);
        } catch {
          /* already dead — swallow */
        }
      }
    }
    if (this.status === 'connected' || this.status === 'qr' || this.status === 'connecting') {
      this.setStatus('disconnected');
      this.emitConnection({
        status: 'disconnected',
        reason: 'manual disconnect',
        reconnectCount: this.reconnectCount,
      });
    }
  }

  async sendMessage(msg: OutgoingMessage): Promise<{ waMessageId: string }> {
    const sock = this.sock;
    if (!sock || this.status !== 'connected') {
      throw new Error(`not connected (status=${this.status}) — cannot send to ${msg.jid}`);
    }
    try {
      const content = msg.asVoiceNote
        ? { audio: Buffer.from(msg.body, 'base64'), ptt: true, mimetype: 'audio/mpeg' }
        : { text: msg.body };
      const result = await sock.sendMessage(msg.jid, content);
      const waMessageId = result?.key?.id ?? '';
      log.debug({ jid: msg.jid, waMessageId, voice: Boolean(msg.asVoiceNote) }, 'message sent');
      return { waMessageId };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.error({ jid: msg.jid, err: reason }, 'sendMessage failed');
      throw new Error(`sendMessage to ${msg.jid} failed: ${reason}`, { cause: err });
    }
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  onConnectionUpdate(handler: (ev: ConnectionEvent) => void): void {
    this.connectionHandlers.push(handler);
  }

  onMessageStatus(handler: (update: MessageStatusUpdate) => void): void {
    this.statusHandlers.push(handler);
  }

  getStatus(): ProviderStatus {
    return this.status;
  }

  /** Latest QR payload awaiting scan, or null. */
  getQrString(): string | null {
    return this.qrString;
  }

  // -------------------------------------------------------------------------
  // Event handling
  // -------------------------------------------------------------------------

  private handleConnectionUpdate(update: Partial<ConnectionState>): void {
    if (update.qr) {
      this.qrString = update.qr;
      this.setStatus('qr');
      log.info('QR received — scan with WhatsApp (Linked Devices)');
      qrcodeTerminal.generate(update.qr, { small: true });
      this.emitConnection({ status: 'qr', qr: update.qr, reconnectCount: this.reconnectCount });
      return;
    }

    if (update.connection === 'connecting') {
      this.setStatus('connecting');
      return;
    }

    if (update.connection === 'open') {
      this.qrString = null;
      this.setStatus('connected');
      log.info({ reconnectCount: this.reconnectCount }, 'connection open');
      this.emitConnection({ status: 'connected', reconnectCount: this.reconnectCount });
      return;
    }

    if (update.connection === 'close') {
      const statusCode = (
        update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined
      )?.output?.statusCode;
      const reason = String(update.lastDisconnect?.error?.message ?? 'closed');
      this.sock = null;
      this.qrString = null;

      if (statusCode === DisconnectReason.loggedOut) {
        this.setStatus('logged_out');
        log.error(
          { statusCode, authDir: config.authDir },
          `logged out — delete auth folder ${config.authDir} and re-auth via QR`,
        );
        this.emitConnection({ status: 'logged_out', reason, reconnectCount: this.reconnectCount });
        return;
      }

      this.reconnectCount += 1;
      this.setStatus('disconnected');
      log.warn(
        { statusCode, reason, reconnectCount: this.reconnectCount },
        'connection closed — health monitor decides reconnection',
      );
      this.emitConnection({ status: 'disconnected', reason, reconnectCount: this.reconnectCount });
    }
  }

  private handleMessagesUpsert(payload: {
    messages: WAMessage[];
    type: MessageUpsertType;
  }): void {
    if (payload.type !== 'notify') return;

    for (const msg of payload.messages) {
      const remoteJid = msg.key?.remoteJid;
      if (!remoteJid) continue;
      if (remoteJid === 'status@broadcast') continue;
      if (remoteJid.endsWith('@g.us')) continue; // MVP: DM only
      if (msg.key?.fromMe) continue;

      const m = msg.message;
      const body =
        m?.conversation ??
        m?.extendedTextMessage?.text ??
        m?.imageMessage?.caption ??
        m?.videoMessage?.caption ??
        null;
      if (!body) continue; // media without caption — text MVP skips

      const tsRaw = Number(msg.messageTimestamp ?? 0);
      const timestamp = Number.isFinite(tsRaw) && tsRaw > 0 ? tsRaw * 1000 : Date.now();

      const incoming: IncomingMessage = {
        waMessageId: msg.key?.id ?? '',
        jid: remoteJid,
        senderJid: remoteJid,
        body,
        timestamp,
        fromMe: Boolean(msg.key?.fromMe),
        kind: 'text',
      };

      for (const handler of this.messageHandlers) {
        try {
          handler(incoming);
        } catch (err) {
          log.error({ err, waMessageId: incoming.waMessageId }, 'message handler threw');
        }
      }
    }
  }

  private handleMessagesUpdate(updates: WAMessageUpdate[]): void {
    for (const update of updates) {
      const status = update.update?.status;
      if (status === undefined || status === null) continue;
      const mapped = mapWaStatus(status);
      if (!mapped) continue;
      this.emitMessageStatus({ waMessageId: update.key?.id ?? '', status: mapped });
    }
  }

  private handleMessageReceipts(receipts: MessageUserReceiptUpdate[]): void {
    for (const { key, receipt } of receipts) {
      const waMessageId = key?.id ?? '';
      if (!waMessageId) continue;
      if (receipt?.readTimestamp) {
        this.emitMessageStatus({ waMessageId, status: 'read' });
      } else if (receipt?.deliveredDeviceJid && receipt.deliveredDeviceJid.length > 0) {
        this.emitMessageStatus({ waMessageId, status: 'delivered' });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private setStatus(next: ProviderStatus): void {
    if (this.status === next) return;
    log.debug({ from: this.status, to: next }, 'provider status transition');
    this.status = next;
  }

  private emitConnection(ev: ConnectionEvent): void {
    for (const handler of this.connectionHandlers) {
      try {
        handler(ev);
      } catch (err) {
        log.error({ err }, 'connection handler threw');
      }
    }
  }

  private emitMessageStatus(update: MessageStatusUpdate): void {
    for (const handler of this.statusHandlers) {
      try {
        handler(update);
      } catch (err) {
        log.error({ err, waMessageId: update.waMessageId }, 'message status handler threw');
      }
    }
  }
}

export function createBaileysProvider(): BaileysProvider {
  return new BaileysProvider();
}
