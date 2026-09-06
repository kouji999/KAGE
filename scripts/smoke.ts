// API smoke test — server harus sudah jalan (npm run dev).
// Jalankan: npm run smoke
import 'dotenv/config';

const BASE = `http://${process.env.KAGE_API_HOST ?? '127.0.0.1'}:${process.env.KAGE_API_PORT ?? '4660'}`;
const TOKEN = proces…OKEN ?? 'kage-dev-token';

let failures = 0;

async function check(name: string, method: string, path: string, body?: unknown): Promise<unknown> {
  try {
    const res = await fetch(`${BASE}/api/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const json = await res.json().catch(() => null);
    const ok = res.status >= 200 && res.status < 300;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${method} ${path} -> ${res.status}`);
    if (!ok) {
      failures++;
      console.log('   body:', JSON.stringify(json)?.slice(0, 300));
    }
    return json;
  } catch (err) {
    console.log(`FAIL ${method} ${path} -> ${(err as Error).message}`);
    failures++;
    return null;
  }
}

// auth negative test
{
  const res = await fetch(`${BASE}/api/v1/health`);
  const ok = res.status === 401;
  console.log(`${ok ? 'PASS' : 'FAIL'} GET /health tanpa token -> ${res.status} (expect 401)`);
  if (!ok) failures++;
}

const health = await check('health', 'GET', '/health');
console.log('   health:', JSON.stringify(health)?.slice(0, 400));

await check('settings', 'GET', '/settings');
await check('mode AUTO', 'PUT', '/settings/mode', { mode: 'AUTO' });
await check('mode invalid', 'PUT', '/settings/mode', { mode: 'NOPE' }); // expect 400 -> counted fail; handle below
await check('mode ASSIST', 'PUT', '/settings/mode', { mode: 'ASSIST' });
await check('mode AUTO again', 'PUT', '/settings/mode', { mode: 'AUTO' });
await check('contacts', 'GET', '/contacts');
await check('conversations', 'GET', '/conversations');
await check('approvals', 'GET', '/approvals');
await check('notifications', 'GET', '/notifications');
await check('reports daily', 'GET', '/reports/daily');
await check('session qr', 'POST', '/session/qr');

// mode invalid harus 400 — koreksi counter di atas
{
  const res = await fetch(`${BASE}/api/v1/settings/mode`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'NOPE' }),
  });
  const ok = res.status === 400;
  console.log(`${ok ? 'PASS' : 'FAIL'} PUT mode invalid -> ${res.status} (expect 400)`);
  if (!ok) failures++;
  else failures--; // undo counter dari check() di atas
}

console.log(failures === 0 ? '\nSMOKE OK — semua endpoint hidup' : `\nSMOKE FAIL — ${failures} error`);
process.exit(failures === 0 ? 0 : 1);
