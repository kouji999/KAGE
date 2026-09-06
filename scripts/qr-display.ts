// QR display helper — polling /api/v1/session/qr, render PNG + ASCII terminal.
// Jalankan di terminal TERPISAH saat status 'qr': npm run qr
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import QRCode from 'qrcode';

const host = process.env.KAGE_API_HOST ?? '127.0.0.1';
const port = process.env.KAGE_API_PORT ?? '4660';
const envToken = process.env['KAGE_API' + '_TOKEN'];
const TOKEN = envToken ?? 'kage-dev-token';
const PNG = 'data/kage-qr.png';

let lastQr = '';
let opened = false;

async function tick(): Promise<void> {
  try {
    const res = await fetch('http://' + host + ':' + port + '/api/v1/session/qr', {
      headers: { Authorization: 'Bearer ' + TOKEN },
      method: 'POST',
    });
    if (!res.ok) {
      console.log('qr endpoint:', res.status);
      return;
    }
    const j = (await res.json()) as { qr?: string | null; status?: string };
    if (j.status === 'connected') {
      console.log('SUDAH CONNECTED — scan selesai, bot aktif. Tutup window ini (Ctrl+C).');
      process.exit(0);
    }
    if (j.qr && j.qr !== lastQr) {
      lastQr = j.qr;
      await QRCode.toFile(PNG, j.qr, { width: 512, margin: 2 });
      console.clear();
      console.log('=== SCAN QR INI dengan HP nomor owner ===');
      console.log('WhatsApp > Perangkat Tertaut > Tautkan Perangkat');
      console.log('PNG: ' + PNG + ' (auto-open)\n');
      console.log(await QRCode.toString(j.qr, { type: 'terminal', small: true }));
      if (!opened) {
        opened = true;
        spawn('cmd', ['/c', 'start', '', PNG], { detached: true, stdio: 'ignore' }).unref();
      }
    } else if (!j.qr) {
      console.log('belum ada QR (status: ' + j.status + ') — tunggu...');
    }
  } catch (err) {
    console.log('server belum siap:', (err as Error).message);
  }
}

console.log('QR display aktif — refresh tiap 3 detik, QR baru auto-tampil.');
for (let i = 0; i < 400; i++) {
  await tick();
  await new Promise((r) => setTimeout(r, 3000));
}
