// Verifikasi slang/gaul comprehension — pipeline penuh, DB TEST TERISOLASI (bukan prod!).
import { setupTestDb } from './_test-init.js';
setupTestDb();

const { initDb, MessageRepository } = await import('../src/storage/index.js');
const { RateLimiter, SendQueue } = await import('../src/queue/index.js');
const { createPipelineContext, Pipeline } = await import('../src/core/pipeline/pipeline.js');
const { MessageStage } = await import('../src/core/pipeline/message.js');
const { ContactStage } = await import('../src/core/pipeline/contact.js');
const { ContextStage } = await import('../src/core/pipeline/context.js');
const { IntentStage } = await import('../src/core/pipeline/intent.js');
const { RelationshipStage } = await import('../src/core/pipeline/relationship.js');
const { MemoryStage } = await import('../src/core/pipeline/memory.js');
const { StrategyStage } = await import('../src/core/pipeline/strategy.js');
const { GenerateStage } = await import('../src/core/pipeline/generate.js');
const { SafetyStage } = await import('../src/core/pipeline/safety.js');
const { SendStage } = await import('../src/core/pipeline/send.js');
const { voice } = await import('../src/core/llm/voice.js');
const typeWP = await import('../src/domain/whatsapp-provider.js');
type IncomingMessage = typeWP.IncomingMessage;
type WhatsAppProvider = typeWP.WhatsAppProvider;

class FakeProvider implements Partial<WhatsAppProvider> {
  sent: { jid: string; body: string }[] = [];
  async sendMessage(msg: { jid: string; body: string }) {
    this.sent.push({ jid: msg.jid, body: msg.body });
    return { waMessageId: 'f' + this.sent.length };
  }
  getStatus() {
    return 'connected' as const;
  }
}

initDb();
const fake = new FakeProvider();
const queue = new SendQueue({
  provider: fake as unknown as WhatsAppProvider,
  messageRepo: MessageRepository,
  rateLimiter: new RateLimiter(),
});
const pipeline = new Pipeline(
  new MessageStage(), new ContactStage(), new ContextStage(), new IntentStage(),
  new RelationshipStage(), new MemoryStage(), new StrategyStage(), new GenerateStage(),
  new SafetyStage(), new SendStage({ queue }),
);

const mk = (jid: string, body: string): IncomingMessage => ({
  waMessageId: 'slang-' + Math.random().toString(36).slice(2),
  jid, senderJid: jid, body, timestamp: Date.now(), fromMe: false, kind: 'text',
});

const cases: { input: string; expectIntent: string[]; label: string }[] = [
  { input: 'gass ngopi bentar, gw otw nih', expectIntent: ['meeting', 'casual', 'commitment'], label: 'gaul: gas/otw' },
  { input: 'anjir lama bgt yg, gmn sih', expectIntent: ['conflict', 'casual', 'question'], label: 'typo+slang: anjir/bgt/yg/gmn' },
  { input: 'bro pinjem dlu 200rb ya, ganti minggu dpn', expectIntent: ['money'], label: 'pinjam uang slang' },
  { input: 'kuy main ke kos, mager nih sendirian', expectIntent: ['commitment', 'meeting', 'casual'], label: 'kuy/mager' },
];

let pass = 0;
let fail = 0;
for (const c of cases) {
  const jid = '62' + Math.floor(8120000000 + Math.random() * 799999999) + '@s.whatsapp.net';
  const ctx = createPipelineContext(mk(jid, c.input));
  await pipeline.run(ctx);
  const ok = c.expectIntent.includes(ctx.intent);
  console.log((ok ? 'PASS' : 'FAIL') + ' [' + c.label + ']');
  console.log('   in : ' + c.input);
  console.log('   intent=' + ctx.intent + ' (expect ' + c.expectIntent.join('/') + ') risk=' + ctx.riskLevel);
  console.log('   out: ' + JSON.stringify(ctx.draft.slice(0, 120)));
  if (ok) pass++; else fail++;
}
console.log('\nSLANG RESULT: ' + pass + ' pass, ' + fail + ' fail');
process.exit(fail === 0 ? 0 : 1);
