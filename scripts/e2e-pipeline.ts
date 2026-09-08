// E2E pipeline verification TANPA WhatsApp: fake provider, LLM + TTS + DB real.
// DB TEST TERISOLASI — tidak menulis ke production.
import { setupTestDb } from './_test-init.js';
setupTestDb();

const { initDb, ApprovalRepository, MessageRepository } = await import('../src/storage/index.js');
const { RateLimiter, SendQueue } = await import('../src/queue/index.js');
const { createPipelineContext, Pipeline } = await import('../src/core/pipeline/pipeline.js');
const { MessageStage } = await import('../src/core/pipeline/message.js');
const { ContactStage } = await import('../src/core/pipeline/contact.js');
const { ContextStage } = await import('../src/core/pipeline/context.js');
const { ClassifyStage } = await import('../src/core/pipeline/classify.js');
const { RelationshipStage } = await import('../src/core/pipeline/relationship.js');
const { MemoryStage } = await import('../src/core/pipeline/memory.js');

const { GenerateStage } = await import('../src/core/pipeline/generate.js');
const { SafetyStage } = await import('../src/core/pipeline/safety.js');
const { SendStage } = await import('../src/core/pipeline/send.js');
const { assertSafeToSend } = await import('../src/core/pipeline/pipeline.js');
const typeWP = await import('../src/domain/whatsapp-provider.js');
type IncomingMessage = typeWP.IncomingMessage;
type WhatsAppProvider = typeWP.WhatsAppProvider;

interface CapturedSend {
  jid: string;
  body: string;
  asVoiceNote: boolean;
}

class FakeProvider implements Partial<WhatsAppProvider> {
  sent: CapturedSend[] = [];
  status: 'connected' | 'disconnected' = 'connected';

  async connect(): Promise<void> {
    this.status = 'connected';
  }

  async sendMessage(msg: { jid: string; body: string; asVoiceNote?: boolean }): Promise<{ waMessageId: string }> {
    this.sent.push({ jid: msg.jid, body: msg.body, asVoiceNote: Boolean(msg.asVoiceNote) });
    return { waMessageId: `fake-${this.sent.length}` };
  }

  getStatus(): 'connected' {
    return 'connected';
  }
}

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ''): void {
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`${tag} ${name}${detail ? ` — ${detail}` : ''}`);
  if (ok) pass++;
  else fail++;
}

async function runSim(pipeline: Pipeline, incoming: IncomingMessage) {
  const ctx = createPipelineContext(incoming);
  await pipeline.run(ctx);
  return ctx;
}

async function main(): Promise<void> {
  initDb();

  const fake = new FakeProvider();
  const queue = new SendQueue({
    provider: fake as unknown as WhatsAppProvider,
    messageRepo: MessageRepository,
    rateLimiter: new RateLimiter(),
  });
  const pipeline = new Pipeline(
    new MessageStage(), new ContactStage(), new ContextStage(), new ClassifyStage(), new RelationshipStage(), new MemoryStage(), new GenerateStage(),
    new SafetyStage(), new SendStage({ queue }),
  );

  const mkMsg = (jid: string, body: string): IncomingMessage => ({
    waMessageId: `e2e-${Math.random().toString(36).slice(2)}`,
    jid, senderJid: jid, body, timestamp: Date.now(), fromMe: false, kind: 'text',
  });

  const TEST_JID = `62${Math.floor(8100000000 + Math.random() * 899999999)}@s.whatsapp.net`;

  console.log('=== SIM 1: casual → AUTO send ===');
  const ctx1 = await runSim(pipeline, mkMsg(TEST_JID, 'bro gimana kabar lo? lama ga ketemu'));
  console.log(`   decision=${ctx1.decision} risk=${ctx1.riskLevel} intent=${ctx1.intent}`);
  console.log(`   draft="${ctx1.draft.slice(0, 80)}"`);
  check('sim1: decision queued/sent', ['queued', 'sent'].includes(ctx1.decision), `got ${ctx1.decision}`);
  check('sim1: risk LOW/MEDIUM', ctx1.riskLevel !== 'HIGH', `got ${ctx1.riskLevel}`);
  check('sim1: draft non-kosong', ctx1.draft.length > 0, `len=${ctx1.draft.length}`);
  check('sim1: pesan terkirim via fake provider', fake.sent.length > 0, `sent=${fake.sent.length}`);

  console.log('=== SIM 2: money/commitment → HIGH → approval ===');
  fake.sent = [];
  const ctx2 = await runSim(pipeline, mkMsg(TEST_JID, 'besok gua transfer 500rb ke lo ya, janji besok pagi'));
  console.log(`   decision=${ctx2.decision} risk=${ctx2.riskLevel} intent=${ctx2.intent}`);
  check('sim2: risk HIGH', ctx2.riskLevel === 'HIGH', `got ${ctx2.riskLevel}`);
  check('sim2: decision approval', ctx2.decision === 'approval', `got ${ctx2.decision}`);
  const pending = ApprovalRepository.getPending();
  check('sim2: approval pending tercatat', pending.length > 0, `pending=${pending.length}`);
  check('sim2: TIDAK ada kirim otomatis (hard rule)', fake.sent.length === 0, `sent=${fake.sent.length}`);

  console.log('=== SIM 3: hard rule assertSafeToSend ===');
  let threw = false;
  try {
    assertSafeToSend({ ...createPipelineContext(mkMsg(TEST_JID, 'x')), riskLevel: 'HIGH' });
  } catch {
    threw = true;
  }
  check('sim3: HIGH tanpa approval → throw', threw);

  console.log('=== SIM 4: draft kosong/media tanpa caption → skip ===');
  const ctx4 = await runSim(pipeline, mkMsg(TEST_JID, ''));
  check('sim4: decision skipped', ctx4.decision === 'skipped', `got ${ctx4.decision}`);

  console.log(`\nE2E RESULT: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error('E2E fatal:', err);
  process.exit(1);
});
