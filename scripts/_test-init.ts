// GUARD WAJIB untuk semua script test: isolasi DB test, JANGAN sentuh data production.
// Letakkan: import ini duluan sebelum import modul src/ lain.
//
// Pemakaian:
//   import { setupTestDb } from './_test-init.js';
//   setupTestDb();
//   const { initDb } = await import('../src/storage/index.js'); // dynamic import!
//
// Static import modul src/ TIDAK BOLEH — config ter-cache saat hoist sebelum env diset.

import { mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function setupTestDb(): void {
  const dir = path.join(os.tmpdir(), 'kage-test-' + process.pid + '-' + Date.now());
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  process.env.KAGE_DB_PATH = path.join(dir, 'test.db');
  process.env.KAGE_AUTH_DIR = path.join(dir, 'auth');
  console.log('[test] isolated DB:', process.env.KAGE_DB_PATH);
}
