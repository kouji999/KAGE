// E2E pipeline verification TANPA WhatsApp: fake provider, LLM + TTS + DB real.
// Bukti alur: casual → AUTO send; money/commitment → HIGH → approval; hard rule HIGH.
// Jalankan: npx tsx scripts/e2e-pipeline.ts
import { initDb, ApprovalRepository, MessageRepository } from '../src/storage/index.js';
import { RateLimiter, SendQueue } from '../src/queue/index.js';
import { createPipelineContext, Pipeline } from '../src/core/pipeline/pipeline.js';
import { MessageStage } from '../src/core/pipeline/message.js';
import { ContactStage } from '../src/core/pipeline/contact.js';
import { ContextStage } from '../src/core/pipeline/context.js';
import { IntentStage } from '../src/core/pipeline/intent.js';
import { RelationshipStage } from '../src/core/pipeline/relationship.js';
import { MemoryStage } from '../src/core/pipeline/memory.js';
import { StrategyStage } from '../src/core/pipeline/strategy.js';
import { GenerateStage } from '../src/core/pipeline/generate.js';
import { SafetyStage } from '../src/core/pipeline/safety.js';
import { SendStage } from '../src/core/pipeline/send.js';
import { assertSafeToSend } from '../src/core/pipeline/pipeline.js';
import type { WhatsAppProvider, IncomingMessage } from '../src/domain/whatsapp-provider.js';

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
    new MessageStage(),
    new ContactStage(),
    new ContextStage(),
    new IntentStage(),
    new RelationshipStage(),
    new MemoryStage(),
    new StrategyStage(),
    new GenerateStage(),
    new SafetyStage(),
    new SendStage({ queue }),
  );

  const mkMsg = (jid: string, body: string): IncomingMessage => ({
    waMessageId: `e2e-${Math.random().toString(36).slice(2)}`,
    jid,
    senderJid: jid,
    body,
    timestamp: Date.now(),
    fromMe: false,
    kind: 'text',
  });

  // Isolation: fresh jid per run supaya history/memori run sebelumnya tidak bocor.
  const TEST_JID = `62${Math.floor(8100000000 + Math.random() * 899999999)}@s.whatsapp.net`;

  console.log('=== SIM 1: casual → AUTO send ===');
  const ctx1 = await runSim(pipeline, mkMsg(TEST_JID, 'bro gimana kabar lo? lama ga ketemu'));
  console.log(`   decision=${ctx1.decision} risk=${ctx1.riskLevel} intent=${ctx1.intent}`);
  console.log(`   draft="${ctx1.draft.slice(0, 80)}"`);
  check('sim1: decision queued/sent', ['queued', 'sent'].includes(ctx1.decision), `got ${ctx1.decision}`);
  check('sim1: risk LOW/MEDIUM', ctx1.riskLevel !== 'HIGH', `got ${ctx1.riskLevel}`);
  check('sim1: draft non-kosong', ctx1.draft.length > 0, `len=${ctx1.draft.length}`);
  check('sim1: pesan terkirim via fake provider', fake.sent.length > 0, `sent=${fake.sent.length}`);
  if (fake.sent.length > 0) {
    check('sim1: jid benar', fake.sent[0].jid === TEST_JID, fake.sent[0].jid);
    console.log(`   voice=${fake.sent[0].asVoiceNote} (TTS real; true = fallback text gagal → false = ok dua2nya)`);
  }

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
