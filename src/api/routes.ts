// Owner API routes — /api/v1/* — JSON only, manual validation, Bearer auth enforced in server.ts.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import { config } from '../config/index.js';
import { logger } from '../config/logger.js';
import type {
  ContactProfile,
  Mode,
  PersonalityProfile,
  Relationship,
} from '../domain/entities.js';
import type { WhatsAppProvider } from '../domain/whatsapp-provider.js';
import {
  ApprovalRepository,
  ContactRepository,
  ConversationRepository,
  LlmUsageRepository,
  MemoryRepository,
  MessageRepository,
  NotificationRepository,
  OwnerRepository,
  SessionRepository,
} from '../storage/index.js';
import { llm } from '../core/llm/client.js';
import type { SendQueue } from '../queue/index.js';

export interface ApiDeps {
  provider: WhatsAppProvider & { getQrString(): string | null };
  queue: SendQueue;
  healthMonitor: { getAttempts(): number };
}

const MODES: Mode[] = ['AUTO', 'ASSIST', 'APPROVAL', 'OFF'];

function badRequest(reply: FastifyReply, detail: string): FastifyReply {
  return reply.code(400).send({ error: 'invalid input', detail });
}

function parseId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function intParam(v: unknown, fallback: number, max: number): number {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** Wrap handler so storage/queue throws become 500 {error} — never crash the panel. */
function guard(app: FastifyInstance, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<void>) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      await handler(req, reply);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'internal error';
      app.log.error({ err, url: req.url }, 'api handler failed');
      if (!reply.sent) reply.code(500).send({ error: message });
    }
  };
}

export function registerRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get('/api/v1/health', guard(app, async (_req, reply) => {
    let llmHealthy = false;
    try {
      llmHealthy = await llm.healthy();
    } catch {
      llmHealthy = false;
    }
    reply.send({
      status: deps.provider.getStatus(),
      attempts: deps.healthMonitor.getAttempts(),
      session: SessionRepository.get(),
      uptimeSec: Math.floor(process.uptime()),
      llmHealthy,
      timestamp: new Date().toISOString(),
    });
  }));

  app.post('/api/v1/session/qr', guard(app, async (_req, reply) => {
    const status = deps.provider.getStatus();
    if (status === 'logged_out') {
      return reply.code(409).send({
        error: 'logged_out',
        hint: 'Delete auth folder and restart',
      });
    }
    reply.send({
      qr: deps.provider.getQrString(),
      status,
      note: 'QR printed in terminal when session starts',
    });
  }));

  app.get('/api/v1/settings', guard(app, async (_req, reply) => {
    const owner = OwnerRepository.get();
    reply.send({
      mode: owner.default_mode,
      personality: owner.personality_profile,
      rate: config.rate,
      llm: {
        model: config.llm.model,
        budgetUsd: config.llm.monthlyBudgetUsd,
        usage: LlmUsageRepository.monthlySummary(),
      },
      voice: {
        enabled: config.voice.enabled,
        model: config.voice.model,
        voiceName: config.voice.voiceName,
        mode: config.voice.mode,
      },
    });
  }));

  app.put('/api/v1/settings/mode', guard(app, async (req, reply) => {
    const body = req.body as { mode?: unknown } | null;
    if (typeof body?.mode !== 'string' || !MODES.includes(body.mode as Mode)) {
      return badRequest(reply, `mode must be one of ${MODES.join('/')}`);
    }
    OwnerRepository.updateMode(body.mode as Mode);
    reply.send({ ok: true, mode: body.mode });
  }));

  app.put('/api/v1/personality', guard(app, async (req, reply) => {
    const body = req.body as { personality?: unknown } | null;
    const p = body?.personality as Partial<PersonalityProfile> | undefined;
    if (
      !p ||
      typeof p !== 'object' ||
      typeof p.character !== 'string' ||
      p.character.trim() === '' ||
      p.character.length > 2000
    ) {
      return badRequest(reply, 'personality.character must be a non-empty string of at most 2000 chars');
    }
    if (p.samples !== undefined && !isStringArray(p.samples)) {
      return badRequest(reply, 'personality.samples must be an array of strings');
    }
    if (p.avoid !== undefined && !isStringArray(p.avoid)) {
      return badRequest(reply, 'personality.avoid must be an array of strings');
    }
    if (p.traits !== undefined && !isStringArray(p.traits)) {
      return badRequest(reply, 'personality.traits must be an array of strings');
    }
    const profile: PersonalityProfile = {
      character: p.character,
      ...(p.traits !== undefined ? { traits: p.traits } : {}),
      ...(p.samples !== undefined ? { samples: p.samples } : {}),
      ...(p.avoid !== undefined ? { avoid: p.avoid } : {}),
    };
    OwnerRepository.updatePersonality(profile);
    reply.send({ ok: true });
  }));

  app.get('/api/v1/contacts', guard(app, async (_req, reply) => {
    reply.send({ contacts: ContactRepository.list() });
  }));

  app.get('/api/v1/contacts/:id', guard(app, async (req, reply) => {
    const id = parseId((req.params as { id: string }).id);
    if (id === null) return badRequest(reply, 'id must be a positive integer');
    const contact = ContactRepository.getById(id);
    if (!contact) return reply.code(404).send({ error: 'not found' });
    const memory = MemoryRepository.listByJid(contact.jid, 20);
    reply.send({ contact, memory });
  }));

  app.put('/api/v1/contacts/:id/profile', guard(app, async (req, reply) => {
    const id = parseId((req.params as { id: string }).id);
    if (id === null) return badRequest(reply, 'id must be a positive integer');
    const body = req.body as { profile?: unknown } | null;
    const p = body?.profile as Partial<ContactProfile> | undefined;
    if (
      !p ||
      typeof p !== 'object' ||
      typeof p.name !== 'string' ||
      !isStringArray(p.preferences ?? []) ||
      typeof p.notes !== 'string'
    ) {
      return badRequest(reply, 'profile must be {name: string, preferences: string[], notes: string}');
    }
    const contact = ContactRepository.getById(id);
    if (!contact) return reply.code(404).send({ error: 'not found' });
    ContactRepository.updateProfile(contact.jid, {
      name: p.name,
      preferences: p.preferences ?? [],
      notes: p.notes,
    });
    reply.send({ ok: true });
  }));

  app.put('/api/v1/contacts/:id/relationship', guard(app, async (req, reply) => {
    const id = parseId((req.params as { id: string }).id);
    if (id === null) return badRequest(reply, 'id must be a positive integer');
    const body = req.body as { relationship?: unknown } | null;
    const r = body?.relationship as Partial<Relationship> | undefined;
    const ClosenessValues: readonly Relationship['closeness'][] = ['close', 'normal', 'distant', 'unknown'];
    const closeness = r?.closeness as Relationship['closeness'] | undefined;
    if (
      !r ||
      typeof r !== 'object' ||
      typeof r.type !== 'string' ||
      typeof closeness !== 'string' ||
      !ClosenessValues.includes(closeness) ||
      typeof r.notes !== 'string'
    ) {
      return badRequest(
        reply,
        'relationship must be {type: string, closeness: close|normal|distant|unknown, notes: string}',
      );
    }
    const contact = ContactRepository.getById(id);
    if (!contact) return reply.code(404).send({ error: 'not found' });
    ContactRepository.updateRelationship(contact.jid, {
      type: r.type,
      closeness: closeness,
      notes: r.notes,
    });
    reply.send({ ok: true });
  }));

  app.post('/api/v1/contacts/:id/risk-note', guard(app, async (req, reply) => {
    const id = parseId((req.params as { id: string }).id);
    if (id === null) return badRequest(reply, 'id must be a positive integer');
    const body = req.body as { note?: unknown } | null;
    if (typeof body?.note !== 'string' || body.note.trim() === '') {
      return badRequest(reply, 'note must be a non-empty string');
    }
    const contact = ContactRepository.getById(id);
    if (!contact) return reply.code(404).send({ error: 'not found' });
    ContactRepository.addRiskNote(contact.jid, body.note);
    reply.send({ ok: true });
  }));

  app.get('/api/v1/conversations', guard(app, async (req, reply) => {
    const q = req.query as { limit?: unknown; offset?: unknown };
    reply.send({
      conversations: ConversationRepository.list(
        intParam(q.limit, 50, 200),
        Number.isInteger(Number(q.offset)) && Number(q.offset) >= 0 ? Number(q.offset) : 0,
      ),
    });
  }));

  app.get('/api/v1/conversations/:id', guard(app, async (req, reply) => {
    const id = parseId((req.params as { id: string }).id);
    if (id === null) return badRequest(reply, 'id must be a positive integer');
    const conv = ConversationRepository.getById(id);
    if (!conv) return reply.code(404).send({ error: 'not found' });
    const q = req.query as { limit?: unknown };
    reply.send({
      conversation: conv,
      messages: MessageRepository.listByConversation(id, intParam(q.limit, 50, 500)),
    });
  }));

  app.post('/api/v1/conversations/:id/release', guard(app, async (req, reply) => {
    const id = parseId((req.params as { id: string }).id);
    if (id === null) return badRequest(reply, 'id must be a positive integer');
    const conv = ConversationRepository.getById(id);
    if (!conv) return reply.code(404).send({ error: 'not found' });
    ConversationRepository.setTakenOver(id, false);
    reply.send({ ok: true });
  }));

  app.get('/api/v1/approvals', guard(app, async (_req, reply) => {
    reply.send({ pending: ApprovalRepository.getPending() });
  }));

  /** Owner manual send — teks atau voice note (TTS Flux via OpenRouter). */
  app.post('/api/v1/send', guard(app, async (req, reply) => {
    const b = (req.body ?? {}) as {
      phone?: unknown;
      jid?: unknown;
      body?: unknown;
      voice?: unknown;
    };
    let jid: string | null = null;
    if (typeof b.phone === 'string' && b.phone.trim() !== '') {
      const digits = b.phone.replace(/\D/g, '');
      if (digits.length < 8) return badRequest(reply, 'phone tidak valid');
      const norm = digits.startsWith('0') ? '62' + digits.slice(1) : digits;
      jid = `${norm}@s.whatsapp.net`;
    } else if (typeof b.jid === 'string' && b.jid.endsWith('@s.whatsapp.net')) {
      jid = b.jid;
    }
    if (!jid) return badRequest(reply, 'field "phone" (mis. 089501903835) atau "jid" wajib');
    if (typeof b.body !== 'string' || b.body.trim() === '' || b.body.length > 4000) {
      return badRequest(reply, 'field "body" wajib (1-4000 karakter)');
    }
    if (deps.provider.getStatus() !== 'connected') {
      return reply.code(409).send({ error: 'not connected', detail: `status ${deps.provider.getStatus()}` });
    }
    const voice = b.voice === undefined ? undefined : Boolean(b.voice);
    await deps.queue.enqueueRawText(jid, b.body.trim(), 'LOW', voice);
    reply.send({ ok: true, jid, voice: voice ?? null, note: 'queued (voice sesuai flag / config)' });
  }));

  /** OTP pairing code — alternatif scan QR (nomor telepon saja, tanpa kamera). */
  app.post('/api/v1/session/pairing-code', guard(app, async (req, reply) => {
    const b = (req.body ?? {}) as { phone?: unknown };
    if (typeof b.phone !== 'string' || b.phone.replace(/\D/g, '').length < 8) {
      return badRequest(reply, 'field "phone" wajib (mis. 087726681286)');
    }
    const st = deps.provider.getStatus();
    if (st === 'connected' || st === 'off') {
      return reply.code(409).send({
        error: 'pairing tidak tersedia',
        detail: `status ${st} — pairing code hanya saat menunggu QR`,
      });
    }
    try {
      const code = await deps.provider.requestPairingCode(b.phone);
      reply.send({
        ok: true,
        code,
        note: 'Masukkan kode ini di HP: WhatsApp > Perangkat Tertaut > Tautkan dengan nomor telepon > masukkan kode. Berlaku beberapa menit.',
      });
    } catch (err) {
      reply.code(502).send({ error: 'pairing code gagal', detail: err instanceof Error ? err.message : String(err) });
    }
  }));

  app.post('/api/v1/approvals/:id/approve', guard(app, async (req, reply) => {
    const id = parseId((req.params as { id: string }).id);
    if (id === null) return badRequest(reply, 'id must be a positive integer');
    const approval = ApprovalRepository.getById(id);
    if (!approval) return reply.code(404).send({ error: 'not found' });
    if (approval.status !== 'pending') {
      return reply.code(409).send({ error: 'not pending', detail: `status is ${approval.status}` });
    }
    ApprovalRepository.decide(id, 'approved', 'owner approved');
    // Owner explicitly approved — HIGH risk send is intentional here; SendQueue does not re-enforce.
    await deps.queue.enqueueSend({
      conversationId: approval.conversation_id,
      contactJid: approval.contact_jid,
      body: approval.draft_body,
      riskLevel: approval.risk_level,
    });
    reply.send({ ok: true, sent: true });
  }));

  app.post('/api/v1/approvals/:id/reject', guard(app, async (req, reply) => {
    const id = parseId((req.params as { id: string }).id);
    if (id === null) return badRequest(reply, 'id must be a positive integer');
    const approval = ApprovalRepository.getById(id);
    if (!approval) return reply.code(404).send({ error: 'not found' });
    if (approval.status !== 'pending') {
      return reply.code(409).send({ error: 'not pending', detail: `status is ${approval.status}` });
    }
    ApprovalRepository.decide(id, 'rejected', 'owner rejected');
    reply.send({ ok: true });
  }));

  app.post('/api/v1/approvals/:id/edit', guard(app, async (req, reply) => {
    const id = parseId((req.params as { id: string }).id);
    if (id === null) return badRequest(reply, 'id must be a positive integer');
    const approval = ApprovalRepository.getById(id);
    if (!approval) return reply.code(404).send({ error: 'not found' });
    if (approval.status !== 'pending') {
      return reply.code(409).send({ error: 'not pending', detail: `status is ${approval.status}` });
    }
    const body = req.body as { body?: unknown } | null;
    if (typeof body?.body !== 'string' || body.body.trim() === '') {
      return badRequest(reply, 'body must be a non-empty string');
    }
    ApprovalRepository.decide(id, 'edited', body.body);
    await deps.queue.enqueueSend({
      conversationId: approval.conversation_id,
      contactJid: approval.contact_jid,
      body: body.body,
      riskLevel: approval.risk_level,
    });
    reply.send({ ok: true });
  }));

  app.post('/api/v1/approvals/:id/takeover', guard(app, async (req, reply) => {
    const id = parseId((req.params as { id: string }).id);
    if (id === null) return badRequest(reply, 'id must be a positive integer');
    const approval = ApprovalRepository.getById(id);
    if (!approval) return reply.code(404).send({ error: 'not found' });
    if (approval.status !== 'pending') {
      return reply.code(409).send({ error: 'not pending', detail: `status is ${approval.status}` });
    }
    ApprovalRepository.decide(id, 'taken_over', 'owner takes over');
    ConversationRepository.setTakenOver(approval.conversation_id, true);
    NotificationRepository.add('takeover', { conversationId: approval.conversation_id });
    reply.send({
      ok: true,
      note: 'KAGE stops replying in this conversation until released',
    });
  }));

  app.get('/api/v1/reports/daily', guard(app, async (_req, reply) => {
    reply.send({
      today: {
        messagesIn: MessageRepository.countToday(),
        llm: LlmUsageRepository.todaySummary(),
      },
      approvals: ApprovalRepository.list(20),
      usageMonth: LlmUsageRepository.monthlySummary(),
    });
  }));

  app.get('/api/v1/notifications', guard(app, async (req, reply) => {
    const q = req.query as { limit?: unknown };
    reply.send({ notifications: NotificationRepository.listAll(intParam(q.limit, 30, 200)) });
  }));

  app.post('/api/v1/notifications/:id/read', guard(app, async (req, reply) => {
    const id = parseId((req.params as { id: string }).id);
    if (id === null) return badRequest(reply, 'id must be a positive integer');
    NotificationRepository.markRead(id);
    reply.send({ ok: true });
  }));
}
