// Quick personality live check: generate via LLM real, persona asisten AI.
// DB TEST TERISOLASI — tidak menulis ke production.
import { setupTestDb } from './_test-init.js';
setupTestDb();

const { initDb, OwnerRepository } = await import('../src/storage/index.js');
const { llm } = await import('../src/core/llm/client.js');
const { buildPersonalityPrompt } = await import('../src/core/personality/engine.js');

initDb();
const p = OwnerRepository.get().personality_profile;
console.log('persona:', p.character.slice(0, 70));

const system = buildPersonalityPrompt();

const tests = [
  'wey kok lo gak bales2? kesel nih gua tungguin',
  'yah kok gitu sih jawabannya, asik dikit dong',
  'besok main bola yuk jam 4! janji ya dateng',
];

for (const t of tests) {
  const r = await llm.chat(
    [
      { role: 'system', content: system },
      {
        role: 'user',
        content:
          'Pesan terbaru dari kontak:\n' +
          t +
          '\n\nStrategi: reply — Balas pesan ini langsung.\n\nTulis balasanmu sekarang.',
      },
    ],
    { purpose: 'generate', maxTokens: 2000 },
  );
  const clean = r.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  console.log('\nIN : ' + t);
  console.log('OUT: ' + clean.slice(0, 200));
}
