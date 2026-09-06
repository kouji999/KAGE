// Transport abstraction. KAGE Core must depend on this interface, never on Baileys directly.
// Replace transport = implement WhatsAppProvider anew; core stays untouched.

export type ProviderStatus =
  | 'connecting'
  | 'qr' // waiting for QR scan
  | 'connected'
  | 'disconnected' // transient, health monitor will reconnect
  | 'logged_out' // unrecoverable, needs new QR auth
  | 'off'; // graceful OFF after retry limit

export interface IncomingMessage {
  waMessageId: string;
  jid: string;
  /** Sender JID when message comes from group; equals jid for DMs */
  senderJid: string;
  body: string;
  timestamp: number;
  fromMe: boolean;
  /** raw message type hint: text, image, audio, unknown */
  kind: 'text' | 'image' | 'audio' | 'unknown';
}

export interface OutgoingMessage {
  jid: string;
  body: string;
  /** send as voice note (PTT) instead of text */
  asVoiceNote?: boolean;
}

export interface ConnectionEvent {
  status: ProviderStatus;
  qr?: string;
  reason?: string;
  /** reconnect attempts so far */
  reconnectCount: number;
}

export interface WhatsAppProvider {
  /** Start connection. Resolves once the connect attempt is issued (not necessarily connected). */
  connect(): Promise<void>;
  /** Disconnect. */
  disconnect(): Promise<void>;
  /** Send a message. Throws on failure. */
  sendMessage(msg: OutgoingMessage): Promise<{ waMessageId: string }>;
  /** Subscribe to incoming messages (DM + groups). */
  onMessage(handler: (msg: IncomingMessage) => void): void;
  /** Subscribe to connection lifecycle updates. */
  onConnectionUpdate(handler: (ev: ConnectionEvent) => void): void;
  /** Subscribe to message status updates (sent → delivered/read, failures). */
  onMessageStatus(handler: (update: { waMessageId: string; status: 'sent' | 'delivered' | 'read' | 'failed' }) => void): void;
  /** Current snapshot of connection state. */
  getStatus(): ProviderStatus;
}
