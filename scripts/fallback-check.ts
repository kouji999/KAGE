// Verifikasi fallback chain: primary DISABILIT (URL mati) → harus terlayani via backup 9router.
import { setupTestDb } from './_test-init.js';
setupTestDb();
process.env.LLM_BASE_URL = 'http://127.0.0.1:9/v1'; // port mati — paksa primary gagal
process.env.LLM_TIMEOUT_MS = '5000';

const { initDb } = await import('../src/storage/index.js');
const { llm } = await import('../src/core/llm/client.js');

initDb();
const t0 = Date.now();
const out = await llm.chat(
  [
    { role: 'system', content: 'kamu asisten AI ramah. balas singkat, huruf kecil semua, tanpa emoji.' },
    { role: 'user', content: 'halo, ini beneran raliq?' },
  ],
  { purpose: 'test', maxTokens: 500 },
);
console.log('ms:', Date.now() - t0);
console.log('OUT:', out.slice(0, 200));
const via = out.length > 0 ? 'PASS — fallback 9router terlayani' : 'FAIL';
console.log(via);
process.exit(out.length > 0 ? 0 : 1);
