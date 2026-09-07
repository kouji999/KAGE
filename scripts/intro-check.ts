// Verifikasi self-intro asisten AI pada chat PERTAMA — DB TEST TERISOLASI (bukan prod!).
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
const typeWP = await import('../src/domain/whatsapp-provider.js');
type IncomingMessage = typeWP.IncomingMessage;
type WhatsAppProvider = typeWP.WhatsAppProvider;

class FakeProvider implements Partial<WhatsAppProvider> {
  sent: { jid: string; body: string }[] = [];
  async sendMessage(msg: { jid: string; body: string }) {
    this.sent.push({ jid: msg.jid, body: msg.body });
    return { waMessageId: 'fake-' + this.sent.length };
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
  waMessageId: 'intro-' + Math.random().toString(36).slice(2),
  jid, senderJid: jid, body, timestamp: Date.now(), fromMe: false, kind: 'text',
});

const freshJid = '62' + Math.floor(8110000000 + Math.random() * 899999999) + '@s.whatsapp.net';

console.log('=== CHAT PERTAMA dari kontak baru ===');
const ctx = createPipelineContext(mk(freshJid, 'halo, ini beneran raliq?'));
await pipeline.run(ctx);
console.log('decision:', ctx.decision, '| risk:', ctx.riskLevel);
console.log('DRAFT:', JSON.stringify(ctx.draft));

const lower = ctx.draft.toLowerCase();
const hasIntro = lower.includes('asisten') || lower.includes('ai');
console.log(hasIntro ? 'PASS: intro asisten AI ada' : 'FAIL: tidak ada intro asisten AI');

console.log('\n=== CHAT KEDUA (history ada) ===');
const ctx2 = createPipelineContext(mk(freshJid, 'oh gitu, yaudah ngobrol aja kita'));
await pipeline.run(ctx2);
console.log('decision:', ctx2.decision);
console.log('DRAFT:', JSON.stringify(ctx2.draft));

process.exit(hasIntro ? 0 : 1);
