import { getDb, jsonCol } from './db.js';
import type {
  ApprovalRequest,
  ApprovalStatus,
  Contact,
  ContactProfile,
  Conversation,
  Direction,
  LlmUsage,
  MemoryEntry,
  MemoryType,
  Message,
  MessageStatus,
  Mode,
  Notification,
  Owner,
  PersonalityProfile,
  RateLimitState,
  Relationship,
  RiskLevel,
  SessionState,
  SessionStatus,
} from '../domain/entities.js';

function nowIso(): string {
  return new Date().toISOString();
}

function startOfTodayUtcIso(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

function startOfMonthUtcIso(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

// ---------------------------------------------------------------------------
// Raw row shapes (as stored in SQLite)
// ---------------------------------------------------------------------------

interface OwnerRow {
  id: number;
  personality_profile: string;
  default_mode: string;
  notification_jid: string;
}
interface ContactRow {
  id: number;
  jid: string;
  name: string;
  profile: string;
  relationship: string;
  risk_notes: string;
  created_at: string;
}
interface ConversationRow {
  id: number;
  contact_jid: string;
  mode_used: string;
  taken_over: number;
  started_at: string;
  last_activity_at: string;
}
interface MessageRow {
  id: number;
  wa_message_id: string;
  conversation_id: number;
  contact_jid: string;
  direction: string;
  body: string;
  status: string;
  risk_level: string | null;
  attempt: number;
  pipeline_result: string | null;
  created_at: string;
}
interface MemoryRow {
  id: number;
  contact_jid: string;
  type: string;
  content: string;
  created_at: string;
}
interface ApprovalRow {
  id: number;
  message_id: number;
  conversation_id: number;
  contact_jid: string;
  draft_body: string;
  risk_level: string;
  status: string;
  owner_decision: string | null;
  decided_at: string | null;
  created_at: string;
}
interface SessionRow {
  id: number;
  status: string;
  last_connected_at: string | null;
  reconnect_count: number;
}
interface RateLimitRow {
  jid: string;
  window_start: string;
  message_count: number;
}
interface LlmUsageRow {
  id: number;
  purpose: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  est_cost_usd: number;
  created_at: string;
}
interface NotificationRow {
  id: number;
  kind: string;
  payload: string;
  created_at: string;
  read: number;
}

const DEFAULT_PROFILE: ContactProfile = { name: '', preferences: [], notes: '' };
const DEFAULT_RELATIONSHIP: Relationship = { type: 'unknown', closeness: 'unknown', notes: '' };

// ---------------------------------------------------------------------------
// Owner
// ---------------------------------------------------------------------------

export class OwnerRepository {
  private static map(r: OwnerRow): Owner {
    return {
      id: r.id,
      personality_profile: jsonCol<PersonalityProfile>(r.personality_profile, { character: '' }),
      default_mode: r.default_mode as Mode,
      notification_jid: r.notification_jid,
    };
  }

  static get(): Owner {
    const row = getDb().prepare(`SELECT * FROM owner WHERE id = 1`).get() as OwnerRow | undefined;
    if (!row) throw new Error('owner row missing — db not seeded');
    return this.map(row);
  }

  static updatePersonality(p: PersonalityProfile): void {
    getDb()
      .prepare(`UPDATE owner SET personality_profile = ? WHERE id = 1`)
      .run(JSON.stringify(p));
  }

  static updateMode(m: Mode): void {
    getDb().prepare(`UPDATE owner SET default_mode = ? WHERE id = 1`).run(m);
  }

  static updateNotificationJid(jid: string): void {
    getDb().prepare(`UPDATE owner SET notification_jid = ? WHERE id = 1`).run(jid);
  }
}

// ---------------------------------------------------------------------------
// Contact
// ---------------------------------------------------------------------------

export class ContactRepository {
  private static map(r: ContactRow): Contact {
    return {
      id: r.id,
      jid: r.jid,
      name: r.name,
      profile: jsonCol<ContactProfile>(r.profile, DEFAULT_PROFILE),
      relationship: jsonCol<Relationship>(r.relationship, DEFAULT_RELATIONSHIP),
      risk_notes: r.risk_notes,
      created_at: r.created_at,
    };
  }

  static upsertByJid(jid: string, name?: string): Contact {
    const db = getDb();
    const existing = db.prepare(`SELECT * FROM contacts WHERE jid = ?`).get(jid) as
      | ContactRow
      | undefined;

    if (existing) {
      if (name && name.trim() !== '' && name !== existing.name) {
        db.prepare(`UPDATE contacts SET name = ? WHERE jid = ?`).run(name, jid);
        const updated = db.prepare(`SELECT * FROM contacts WHERE jid = ?`).get(jid) as ContactRow;
        return this.map(updated);
      }
      return this.map(existing);
    }

    const created = nowIso();
    const info = db
      .prepare(
        `INSERT INTO contacts (jid, name, profile, relationship, risk_notes, created_at)
         VALUES (?, ?, ?, ?, '', ?)`,
      )
      .run(jid, name ?? '', JSON.stringify(DEFAULT_PROFILE), JSON.stringify(DEFAULT_RELATIONSHIP), created);

    const row = db
      .prepare(`SELECT * FROM contacts WHERE id = ?`)
      .get(Number(info.lastInsertRowid)) as ContactRow;
    return this.map(row);
  }

  static getByJid(jid: string): Contact | null {
    const row = getDb().prepare(`SELECT * FROM contacts WHERE jid = ?`).get(jid) as
      | ContactRow
      | undefined;
    return row ? this.map(row) : null;
  }

  static getById(id: number): Contact | null {
    const row = getDb().prepare(`SELECT * FROM contacts WHERE id = ?`).get(id) as
      | ContactRow
      | undefined;
    return row ? this.map(row) : null;
  }

  static list(): Contact[] {
    const rows = getDb().prepare(`SELECT * FROM contacts ORDER BY created_at DESC`).all() as ContactRow[];
    return rows.map((r) => this.map(r));
  }

  static updateProfile(jid: string, p: ContactProfile): void {
    getDb().prepare(`UPDATE contacts SET profile = ? WHERE jid = ?`).run(JSON.stringify(p), jid);
  }

  static updateRelationship(jid: string, r: Relationship): void {
    getDb()
      .prepare(`UPDATE contacts SET relationship = ? WHERE jid = ?`)
      .run(JSON.stringify(r), jid);
  }

  static addRiskNote(jid: string, note: string): void {
    const db = getDb();
    const row = db.prepare(`SELECT risk_notes FROM contacts WHERE jid = ?`).get(jid) as
      | { risk_notes: string }
      | undefined;
    if (!row) return;
    const next = row.risk_notes ? `${row.risk_notes} | ${note}` : note;
    db.prepare(`UPDATE contacts SET risk_notes = ? WHERE jid = ?`).run(next, jid);
  }
}

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

export class ConversationRepository {
  private static map(r: ConversationRow): Conversation {
    return {
      id: r.id,
      contact_jid: r.contact_jid,
      mode_used: r.mode_used as Mode,
      taken_over: r.taken_over !== 0,
      started_at: r.started_at,
      last_activity_at: r.last_activity_at,
    };
  }

  static ensureForJid(contactJid: string, mode: Mode): Conversation {
    const existing = this.getByJid(contactJid);
    if (existing) return existing;

    const now = nowIso();
    const info = getDb()
      .prepare(
        `INSERT INTO conversations (contact_jid, mode_used, taken_over, started_at, last_activity_at)
         VALUES (?, ?, 0, ?, ?)`,
      )
      .run(contactJid, mode, now, now);

    const row = getDb()
      .prepare(`SELECT * FROM conversations WHERE id = ?`)
      .get(Number(info.lastInsertRowid)) as ConversationRow;
    return this.map(row);
  }

  static getByJid(jid: string): Conversation | null {
    const row = getDb()
      .prepare(`SELECT * FROM conversations WHERE contact_jid = ? ORDER BY last_activity_at DESC, id DESC LIMIT 1`)
      .get(jid) as ConversationRow | undefined;
    return row ? this.map(row) : null;
  }

  static getById(id: number): Conversation | null {
    const row = getDb().prepare(`SELECT * FROM conversations WHERE id = ?`).get(id) as
      | ConversationRow
      | undefined;
    return row ? this.map(row) : null;
  }

  static list(limit = 50, offset = 0): Conversation[] {
    const rows = getDb()
      .prepare(`SELECT * FROM conversations ORDER BY last_activity_at DESC LIMIT ? OFFSET ?`)
      .all(limit, offset) as ConversationRow[];
    return rows.map((r) => this.map(r));
  }

  static touch(id: number): void {
    getDb()
      .prepare(`UPDATE conversations SET last_activity_at = ? WHERE id = ?`)
      .run(nowIso(), id);
  }

  static setTakenOver(id: number, v: boolean): void {
    getDb()
      .prepare(`UPDATE conversations SET taken_over = ? WHERE id = ?`)
      .run(v ? 1 : 0, id);
  }

  static setModeUsed(id: number, mode: Mode): void {
    getDb().prepare(`UPDATE conversations SET mode_used = ? WHERE id = ?`).run(mode, id);
  }
}

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

export class MessageRepository {
  private static map(r: MessageRow): Message {
    return {
      id: r.id,
      wa_message_id: r.wa_message_id,
      conversation_id: r.conversation_id,
      contact_jid: r.contact_jid,
      direction: r.direction as Direction,
      body: r.body,
      status: r.status as MessageStatus,
      risk_level: r.risk_level ? (r.risk_level as RiskLevel) : null,
      attempt: r.attempt,
      pipeline_result: r.pipeline_result
        ? jsonCol<Record<string, unknown>>(r.pipeline_result, {})
        : null,
      created_at: r.created_at,
    };
  }

  static insert(m: {
    waMessageId: string;
    conversationId: number;
    contactJid: string;
    direction: Direction;
    body: string;
    status?: MessageStatus;
    riskLevel?: RiskLevel;
    pipelineResult?: Record<string, unknown>;
  }): Message {
    const info = getDb()
      .prepare(
        `INSERT INTO messages
           (wa_message_id, conversation_id, contact_jid, direction, body, status, risk_level, attempt, pipeline_result, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        m.waMessageId,
        m.conversationId,
        m.contactJid,
        m.direction,
        m.body,
        m.status ?? 'pending',
        m.riskLevel ?? null,
        m.pipelineResult ? JSON.stringify(m.pipelineResult) : null,
        nowIso(),
      );
    return this.getById(Number(info.lastInsertRowid)) as Message;
  }

  static updateStatus(id: number, s: MessageStatus): void {
    getDb().prepare(`UPDATE messages SET status = ? WHERE id = ?`).run(s, id);
  }

  static updateRisk(id: number, r: RiskLevel): void {
    getDb().prepare(`UPDATE messages SET risk_level = ? WHERE id = ?`).run(r, id);
  }

  static updatePipelineResult(id: number, json: Record<string, unknown>): void {
    getDb()
      .prepare(`UPDATE messages SET pipeline_result = ? WHERE id = ?`)
      .run(JSON.stringify(json), id);
  }

  static listByConversation(conversationId: number, limit: number): Message[] {
    const rows = getDb()
      .prepare(
        `SELECT * FROM (
           SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT ?
         ) ORDER BY created_at ASC, id ASC`,
      )
      .all(conversationId, limit) as MessageRow[];
    return rows.map((r) => this.map(r));
  }

  static getById(id: number): Message | null {
    const row = getDb().prepare(`SELECT * FROM messages WHERE id = ?`).get(id) as
      | MessageRow
      | undefined;
    return row ? this.map(row) : null;
  }

  static getByWaId(waId: string): Message | null {
    const row = getDb()
      .prepare(`SELECT * FROM messages WHERE wa_message_id = ? ORDER BY id DESC LIMIT 1`)
      .get(waId) as MessageRow | undefined;
    return row ? this.map(row) : null;
  }

  static getRetryable(): Message[] {
    const rows = getDb()
      .prepare(
        `SELECT * FROM messages
         WHERE direction = 'out' AND status IN ('pending', 'failed') AND attempt < 3
         ORDER BY created_at ASC, id ASC`,
      )
      .all() as MessageRow[];
    return rows.map((r) => this.map(r));
  }

  static incrementAttempt(id: number): void {
    getDb().prepare(`UPDATE messages SET attempt = attempt + 1 WHERE id = ?`).run(id);
  }

  static countToday(): number {
    const row = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE created_at >= ?`)
      .get(startOfTodayUtcIso()) as { n: number };
    return row.n;
  }
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export class MemoryRepository {
  private static map(r: MemoryRow): MemoryEntry {
    return {
      id: r.id,
      contact_jid: r.contact_jid,
      type: r.type as MemoryType,
      content: r.content,
      created_at: r.created_at,
    };
  }

  static add(jid: string, type: MemoryType, content: string): void {
    const db = getDb();
    const dup = db
      .prepare(`SELECT 1 FROM memory_entries WHERE contact_jid = ? AND content = ? LIMIT 1`)
      .get(jid, content);
    if (dup) return;
    db.prepare(
      `INSERT INTO memory_entries (contact_jid, type, content, created_at) VALUES (?, ?, ?, ?)`,
    ).run(jid, type, content, nowIso());
  }

  static listByJid(jid: string, limit: number): MemoryEntry[] {
    const rows = getDb()
      .prepare(`SELECT * FROM memory_entries WHERE contact_jid = ? ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(jid, limit) as MemoryRow[];
    return rows.map((r) => this.map(r));
  }
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

export class ApprovalRepository {
  private static map(r: ApprovalRow): ApprovalRequest {
    return {
      id: r.id,
      message_id: r.message_id,
      conversation_id: r.conversation_id,
      contact_jid: r.contact_jid,
      draft_body: r.draft_body,
      risk_level: r.risk_level as RiskLevel,
      status: r.status as ApprovalStatus,
      owner_decision: r.owner_decision,
      decided_at: r.decided_at,
      created_at: r.created_at,
    };
  }

  static create(a: {
    messageId: number;
    conversationId: number;
    contactJid: string;
    draftBody: string;
    riskLevel: RiskLevel;
  }): ApprovalRequest {
    const info = getDb()
      .prepare(
        `INSERT INTO approval_requests
           (message_id, conversation_id, contact_jid, draft_body, risk_level, status, owner_decision, decided_at, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, ?)`,
      )
      .run(a.messageId, a.conversationId, a.contactJid, a.draftBody, a.riskLevel, nowIso());
    return this.getById(Number(info.lastInsertRowid)) as ApprovalRequest;
  }

  static getPending(): ApprovalRequest[] {
    const rows = getDb()
      .prepare(`SELECT * FROM approval_requests WHERE status = 'pending' ORDER BY created_at DESC, id DESC`)
      .all() as ApprovalRow[];
    return rows.map((r) => this.map(r));
  }

  static list(limit = 50): ApprovalRequest[] {
    const rows = getDb()
      .prepare(`SELECT * FROM approval_requests ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(limit) as ApprovalRow[];
    return rows.map((r) => this.map(r));
  }

  static getById(id: number): ApprovalRequest | null {
    const row = getDb().prepare(`SELECT * FROM approval_requests WHERE id = ?`).get(id) as
      | ApprovalRow
      | undefined;
    return row ? this.map(row) : null;
  }

  static decide(id: number, status: ApprovalStatus, ownerDecision: string): void {
    getDb()
      .prepare(`UPDATE approval_requests SET status = ?, owner_decision = ?, decided_at = ? WHERE id = ?`)
      .run(status, ownerDecision, nowIso(), id);
  }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export class SessionRepository {
  private static map(r: SessionRow): SessionState {
    return {
      id: r.id,
      status: r.status as SessionStatus,
      last_connected_at: r.last_connected_at,
      reconnect_count: r.reconnect_count,
    };
  }

  static get(): SessionState {
    const db = getDb();
    db.prepare(`INSERT OR IGNORE INTO session_state (id) VALUES (1)`).run();
    const row = db.prepare(`SELECT * FROM session_state WHERE id = 1`).get() as SessionRow;
    return this.map(row);
  }

  static update(patch: {
    status?: SessionStatus;
    lastConnectedAt?: string;
    reconnectCount?: number;
  }): void {
    const sets: string[] = [];
    const vals: (string | number)[] = [];
    if (patch.status !== undefined) {
      sets.push('status = ?');
      vals.push(patch.status);
    }
    if (patch.lastConnectedAt !== undefined) {
      sets.push('last_connected_at = ?');
      vals.push(patch.lastConnectedAt);
    }
    if (patch.reconnectCount !== undefined) {
      sets.push('reconnect_count = ?');
      vals.push(patch.reconnectCount);
    }
    if (sets.length === 0) return;
    vals.push(1);
    getDb()
      .prepare(`UPDATE session_state SET ${sets.join(', ')} WHERE id = ?`)
      .run(...vals);
  }

  static incrementReconnect(): void {
    getDb()
      .prepare(`UPDATE session_state SET reconnect_count = reconnect_count + 1 WHERE id = 1`)
      .run();
  }
}

// ---------------------------------------------------------------------------
// Rate limit
// ---------------------------------------------------------------------------

export class RateLimitRepository {
  private static map(r: RateLimitRow): RateLimitState {
    return { jid: r.jid, window_start: r.window_start, message_count: r.message_count };
  }

  static get(jid: string): RateLimitState | null {
    const row = getDb().prepare(`SELECT * FROM rate_limit_state WHERE jid = ?`).get(jid) as
      | RateLimitRow
      | undefined;
    return row ? this.map(row) : null;
  }

  static set(jid: string, windowStart: string, count: number): void {
    getDb()
      .prepare(
        `INSERT INTO rate_limit_state (jid, window_start, message_count)
         VALUES (?, ?, ?)
         ON CONFLICT(jid) DO UPDATE SET window_start = excluded.window_start, message_count = excluded.message_count`,
      )
      .run(jid, windowStart, count);
  }
}

// ---------------------------------------------------------------------------
// LLM usage
// ---------------------------------------------------------------------------

export class LlmUsageRepository {
  private static map(r: LlmUsageRow): LlmUsage {
    return {
      id: r.id,
      purpose: r.purpose,
      model: r.model,
      input_tokens: r.input_tokens,
      output_tokens: r.output_tokens,
      est_cost_usd: r.est_cost_usd,
      created_at: r.created_at,
    };
  }

  static add(
    purpose: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
    estCostUsd: number,
  ): void {
    getDb()
      .prepare(
        `INSERT INTO llm_usage (purpose, model, input_tokens, output_tokens, est_cost_usd, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(purpose, model, inputTokens, outputTokens, estCostUsd, nowIso());
  }

  static monthlySummary(): {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    estCostUsd: number;
  } {
    const row = getDb()
      .prepare(
        `SELECT COUNT(*) AS calls,
                COALESCE(SUM(input_tokens), 0) AS inputTokens,
                COALESCE(SUM(output_tokens), 0) AS outputTokens,
                COALESCE(SUM(est_cost_usd), 0) AS estCostUsd
         FROM llm_usage WHERE created_at >= ?`,
      )
      .get(startOfMonthUtcIso()) as {
        calls: number;
        inputTokens: number;
        outputTokens: number;
        estCostUsd: number;
      };
    return {
      calls: row.calls,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      estCostUsd: row.estCostUsd,
    };
  }

  static recent(limit: number): LlmUsage[] {
    const rows = getDb()
      .prepare(`SELECT * FROM llm_usage ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(limit) as LlmUsageRow[];
    return rows.map((r) => this.map(r));
  }

  static todaySummary(): { calls: number; estCostUsd: number } {
    const row = getDb()
      .prepare(
        `SELECT COUNT(*) AS calls, COALESCE(SUM(est_cost_usd), 0) AS estCostUsd
         FROM llm_usage WHERE created_at >= ?`,
      )
      .get(startOfTodayUtcIso()) as { calls: number; estCostUsd: number };
    return { calls: row.calls, estCostUsd: row.estCostUsd };
  }
}

// ---------------------------------------------------------------------------
// Notification
// ---------------------------------------------------------------------------

export class NotificationRepository {
  private static map(r: NotificationRow): Notification {
    return {
      id: r.id,
      kind: r.kind as Notification['kind'],
      payload: r.payload,
      created_at: r.created_at,
      read: r.read !== 0,
    };
  }

  static add(kind: string, payload: Record<string, unknown>): void {
    getDb()
      .prepare(`INSERT INTO notifications (kind, payload, created_at, read) VALUES (?, ?, ?, 0)`)
      .run(kind, JSON.stringify(payload), nowIso());
  }

  static listUnread(limit: number): Notification[] {
    const rows = getDb()
      .prepare(`SELECT * FROM notifications WHERE read = 0 ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(limit) as NotificationRow[];
    return rows.map((r) => this.map(r));
  }

  static listAll(limit: number): Notification[] {
    const rows = getDb()
      .prepare(`SELECT * FROM notifications ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(limit) as NotificationRow[];
    return rows.map((r) => this.map(r));
  }

  static markRead(id: number): void {
    getDb().prepare(`UPDATE notifications SET read = 1 WHERE id = ?`).run(id);
  }
}
