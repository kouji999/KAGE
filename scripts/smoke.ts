// API smoke test — server harus sudah jalan (npm run dev).
// Jalankan: npm run smoke
import 'dotenv/config';

const host = process.env.KAGE_API_HOST ?? '127.0.0.1';
const port = process.env.KAGE_API_PORT ?? '4660';
const BASE = 'http://' + host + ':' + port;
const envToken = process.env['KAGE_API' + '_TOKEN'];
const TOKEN = envToken ?? 'kage-dev-token';

let failures = 0;

async function check(method: string, path: string, body?: unknown): Promise<unknown> {
  try {
    const headers: Record<string, string> = { Authorization: 'Bearer ' + TOKEN };
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(BASE + '/api/v1' + path, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await res.json().catch(() => null)) as unknown;
    const ok = res.status >= 200 && res.status < 300;
    console.log((ok ? 'PASS' : 'FAIL') + ' ' + method + ' ' + path + ' -> ' + res.status);
    if (!ok) {
      failures++;
      const s = JSON.stringify(json) ?? '';
      console.log('   body: ' + s.slice(0, 300));
    }
    return json;
  } catch (err) {
    console.log('FAIL ' + method + ' ' + path + ' -> ' + (err as Error).message);
    failures++;
    return null;
  }
}

// auth negative test
{
  const res = await fetch(BASE + '/api/v1/health');
  const ok = res.status === 401;
  console.log((ok ? 'PASS' : 'FAIL') + ' GET /health no-token -> ' + res.status + ' (expect 401)');
  if (!ok) failures++;
}

const health = (await check('GET', '/health')) as { status?: string } | null;
console.log('   health: ' + JSON.stringify(health)?.slice(0, 400));

await check('GET', '/settings');
await check('PUT', '/settings/mode', { mode: 'AUTO' });
await check('PUT', '/settings/mode', { mode: 'ASSIST' });
await check('PUT', '/settings/mode', { mode: 'AUTO' });
await check('GET', '/contacts');
await check('GET', '/conversations');
await check('GET', '/approvals');
await check('GET', '/notifications');
await check('GET', '/reports/daily');
await check('POST', '/session/qr');

// mode invalid harus 400
{
  const res = await fetch(BASE + '/api/v1/settings/mode', {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'NOPE' }),
  });
  const ok = res.status === 400;
  console.log((ok ? 'PASS' : 'FAIL') + ' PUT mode invalid -> ' + res.status + ' (expect 400)');
  if (!ok) failures++;
}

const msg =
  failures === 0 ? 'SMOKE OK - semua endpoint hidup' : 'SMOKE FAIL - ' + failures + ' error';
console.log('\n' + msg);
process.exit(failures === 0 ? 0 : 1);
