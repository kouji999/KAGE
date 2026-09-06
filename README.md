# KAGE — Your Digital Shadow

Personal AI WhatsApp agent. KAGE membalas pesan seperti owner — gaya sama, keputusan sama — dengan risk-gated auto-reply: percakapan HIGH risk wajib lewat approval owner.

> "When I'm not there, my shadow is."

## Stack
- Node 24 + TypeScript strict (ESM, NodeNext)
- `@whiskeysockets/baileys` 6.7.24 — WhatsApp adapter di balik interface `WhatsAppProvider`
- `better-sqlite3` — session, messages, memory, contacts, approvals, rate limit, LLM usage
- 10-stage pipeline: message → contact → context → intent → relationship → memory → strategy → generate → safety → send
- LLM chat: OpenAI-compatible (TokenRouter `z-ai/glm-5.3-free`)
- Voice TTS: OpenRouter `deepgram/flux-tts:free` → voice note PTT, fallback text
- Fastify 5 — Owner API + web panel (localhost + bearer token)
- `p-queue` — send queue, rate limiter, retry backoff

## Setup

```bash
# 1. deps
npm install

# 2. config
copy .env.example .env   # isi API keys
# format nomor: internasional tanpa + / leading 0 → 0877... jadi 62877...

# 3. run (dev)
npm run dev

# production
npm run build && npm start
```

## Pairing WhatsApp

1. `npm run dev` → QR code ter-print di terminal.
2. Scan dari WhatsApp (nomor owner: 087726681286) → Linked Devices.
3. Session persist di `./auth/`. Restart tidak perlu scan ulang.

Kalau status `logged_out`: hapus folder `auth/`, restart, scan ulang.

## Owner Panel

`http://127.0.0.1:4660` — masukkan bearer token (sama dengan `KAGE_API_TOKEN`).

- Status koneksi + mode (AUTO / ASSIST / APPROVAL / OFF)
- Approval queue: approve / reject / edit / take over
- Riwayat percakapan + log pesan
- LLM usage vs budget bulanan

## API (prefix `/api/v1`, Bearer token)

| Method | Path | Fungsi |
|---|---|---|
| GET | /health | status session, uptime, reconnect, LLM health |
| POST | /session/qr | QR string aktif (kalau menunggu scan) |
| GET | /settings | mode, personality, budget usage, voice config |
| PUT | /settings/mode | ubah mode respons |
| PUT | /personality | update personality profile |
| GET | /contacts | daftar kontak |
| GET | /contacts/:id | detail + memory |
| PUT | /contacts/:id/profile | update profil kontak |
| PUT | /contacts/:id/relationship | update relationship |
| POST | /contacts/:id/risk-note | tambah catatan risiko |
| GET | /conversations | riwayat percakapan |
| GET | /conversations/:id | detail + pesan |
| POST | /conversations/:id/release | kembalikan conversation ke KAGE setelah take over |
| GET | /approvals | approval pending |
| POST | /approvals/:id/approve · reject · edit · takeover | aksi owner |
| GET | /reports/daily | laporan harian |
| GET | /notifications | notifikasi (approval pending, session OFF, reconnect gagal) |

## Risk Model

| Level | Perilaku |
|---|---|
| LOW | mode AUTO → kirim langsung |
| MEDIUM | sesuai mode (AUTO kirim, ASSIST draft, APPROVAL tanya owner) |
| HIGH | SELALU approval owner — hard rule di kode, bukan konvensi. Klasifikasi rule-based (konservatif) + LLM verify, ragu → naik level |

Eskalasi HIGH: intent money/commitment/conflict, janji/transfer/pinjam/utang, konflik & putus hubungan, komitmen atas nama owner.

## Struktur

```
src/
├─ adapters/whatsapp/   # BaileysProvider + HealthMonitor (reconnect, graceful OFF)
├─ api/                  # Fastify server + routes
├─ config/               # env + logger
├─ core/
│  ├─ llm/               # LLM client (chat) + voice client (TTS)
│  ├─ modes/             # AUTO/ASSIST/APPROVAL/OFF
│  ├─ personality/       # personality engine (system prompt)
│  ├─ pipeline/          # 10 stage + orchestrator
├─ domain/               # entities + WhatsAppProvider interface (core tak sentuh Baileys)
├─ panel/                # web panel single-file
├─ queue/                # send queue + rate limiter + retry
├─ storage/              # SQLite schema + repositories
└─ index.ts              # bootstrap
```

## Catatan

- **Hanya chat pribadi (DM)** yang dijawab. Grup, status/story, dan pesan dari nomor owner sendiri di-skip.
- **Default balas teks.** Voice note hanya atas permintaan owner: toggle "Voice note" di panel, atau `voice: true` di API. TTS gagal → otomatis fallback teks.
- Persona default: **Ayanokouji Kiyotaka** — datar, tenang, minim kata, tidak terpancing, tidak pernah berkomitmen atas nama owner. Bisa diubah lewat `PUT /api/v1/personality` atau panel.
- Baileys = unofficial. Rate limiting untuk stabilitas & pola wajar, bukan mengakali enforcement WhatsApp. Risiko session instability diakui eksplisit.

**Author:** Raliq Hidayat BM3
