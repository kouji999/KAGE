// Latensi check: pipeline penuh (classify → generate) dengan timer.
// DB TEST TERISOLASI.
import { setupTestDb } from './_test-init.js';
setupTestDb();

const { initDb, MessageRepository } = await import('../src/storage/index.js');
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
  new MessageStage(), new ContactStage(), new ContextStage(), new ClassifyStage(),
  new RelationshipStage(), new MemoryStage(), new GenerateStage(),
  new SafetyStage(), new SendStage({ queue }),
);

const mk = (jid: string, body: string): IncomingMessage => ({
  waMessageId: 'lat-' + Math.random().toString(36).slice(2),
  jid, senderJid: jid, body, timestamp: Date.now(), fromMe: false, kind: 'text',
});

const jid = '62' + Math.floor(8110000000 + Math.random() * 899999999) + '@s.whatsapp.net';
const inputs = ['bro main gak nanti?', 'besok gua transfer 300rb ya janji'];

for (const input of inputs) {
  const t0 = Date.now();
  const ctx = createPipelineContext(mk(jid, input));
  await pipeline.run(ctx);
  const ms = Date.now() - t0;
  console.log(`IN : ${input}`);
  console.log(`   ${Math.round(ms / 1000)}s | decision=${ctx.decision} intent=${ctx.intent} risk=${ctx.riskLevel} strategy=${ctx.strategy}`);
  console.log(`   OUT: ${JSON.stringify(ctx.draft.slice(0, 100))}`);
}

console.log('\nLATENCY CHECK DONE');
