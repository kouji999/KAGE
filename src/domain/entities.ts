// Domain entities — single source of truth. Core/adapters/storage/api may import ONLY from src/domain.

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';
export type Mode = 'AUTO' | 'ASSIST' | 'APPROVAL' | 'OFF';
export type Direction = 'in' | 'out';
export type MessageStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'failed';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'edited' | 'taken_over';
export type SessionStatus = 'connected' | 'disconnected' | 'off';
export type MemoryType = 'fact' | 'event' | 'preference';

export interface PersonalityProfile {
  /** Deskripsi karakter & gaya komunikasi owner */
  character: string;
  /** Behavioral traits override (default: calm, observant, rational, strategic, low-profile confidence) */
  traits?: string[];
  /** Contoh gaya bicara owner (sampel chat) */
  samples?: string[];
  /** Hal yang harus dihindari dalam respons */
  avoid?: string[];
}

export interface Owner {
  id: number;
  personality_profile: PersonalityProfile;
  default_mode: Mode;
  notification_jid: string;
}

export interface ContactProfile {
  name: string;
  preferences: string[];
  notes: string;
}

export interface Relationship {
  /** keluarga | teman | kolega | klien | unknown */
  type: string;
  closeness: 'close' | 'normal' | 'distant' | 'unknown';
  notes: string;
}

export interface Contact {
  id: number;
  jid: string;
  name: string;
  profile: ContactProfile;
  relationship: Relationship;
  risk_notes: string;
  created_at: string;
}

export interface Conversation {
  id: number;
  contact_jid: string;
  mode_used: Mode;
  /** KAGE mundur dari conversation ini (take over aktif) sampai owner balikin */
  taken_over: boolean;
  started_at: string;
  last_activity_at: string;
}

export interface Message {
  id: number;
  wa_message_id: string;
  conversation_id: number;
  contact_jid: string;
  direction: Direction;
  body: string;
  status: MessageStatus;
  risk_level: RiskLevel | null;
  attempt: number;
  pipeline_result: Record<string, unknown> | null;
  created_at: string;
}

export interface MemoryEntry {
  id: number;
  contact_jid: string;
  type: MemoryType;
  content: string;
  created_at: string;
}

export interface ApprovalRequest {
  id: number;
  message_id: number;
  conversation_id: number;
  contact_jid: string;
  draft_body: string;
  risk_level: RiskLevel;
  status: ApprovalStatus;
  owner_decision: string | null;
  decided_at: string | null;
  created_at: string;
}

export interface SessionState {
  id: number;
  status: SessionStatus;
  last_connected_at: string | null;
  reconnect_count: number;
}

export interface RateLimitState {
  jid: string;
  window_start: string;
  message_count: number;
}

export interface LlmUsage {
  id: number;
  purpose: string; // intent | strategy | generate | safety | tts
  model: string;
  input_tokens: number;
  output_tokens: number;
  est_cost_usd: number;
  created_at: string;
}

export interface Notification {
  id: number;
  kind: 'approval_pending' | 'session_off' | 'reconnect_failed' | 'takeover' | 'info';
  payload: string; // JSON string
  created_at: string;
  read: boolean;
}
