import 'dotenv/config';
import path from 'node:path';

function num(v: string | undefined, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== '' ? n : d;
}
function str(v: string | undefined, d: string): string {
  return v && v.trim() !== '' ? v.trim() : d;
}

const projectRoot = process.cwd();

/** Normalize phone to WhatsApp JID: strip non-digits, drop leading 0 (ID) -> 62..., append @s.whatsapp.net */
export function phoneToJid(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  const norm = digits.startsWith('0') ? '62' + digits.slice(1) : digits;
  return `${norm}@s.whatsapp.net`;
}

export const config = {
  dbPath: path.resolve(projectRoot, str(process.env.KAGE_DB_PATH, './data/kage.db')),
  authDir: path.resolve(projectRoot, str(process.env.KAGE_AUTH_DIR, './auth')),
  dataDir: path.resolve(projectRoot, './data'),

  api: {
    host: str(process.env.KAGE_API_HOST, '127.0.0.1'),
    port: num(process.env.KAGE_API_PORT, 4660),
    token: str(process.env.KAGE_API_TOKEN, 'kage-dev-token'),
  },

  owner: {
    phone: str(process.env.KAGE_OWNER_PHONE, ''),
    get jid(): string {
      return phoneToJid(this.phone);
    },
    defaultMode: (['AUTO', 'ASSIST', 'APPROVAL', 'OFF'].includes(
      str(process.env.KAGE_DEFAULT_MODE, 'AUTO'),
    )
      ? str(process.env.KAGE_DEFAULT_MODE, 'AUTO')
      : 'AUTO') as 'AUTO' | 'ASSIST' | 'APPROVAL' | 'OFF',
  },

  llm: {
    baseUrl: str(process.env.LLM_BASE_URL, 'https://api.tokenrouter.com/v1'),
    apiKey: str(process.env.LLM_API_KEY, ''),
    model: str(process.env.LLM_MODEL, 'z-ai/glm-5.3-free'),
    maxTokens: num(process.env.LLM_MAX_TOKENS, 700),
    monthlyBudgetUsd: num(process.env.LLM_MONTHLY_BUDGET_USD, 20),
    timeoutMs: num(process.env.LLM_TIMEOUT_MS, 90_000),
    /** Backup provider (user request 2026-09-07): 9router lokal — dipakai kalau primary gagal total. */
    fallback: {
      baseUrl: str(process.env.LLM_FALLBACK_BASE_URL, ''),
      apiKey: str(process.env.LLM_FALLBACK_API_KEY, process.env.DEVSTACK_API_KEY ?? ''),
      model: str(process.env.LLM_FALLBACK_MODEL, ''),
      /** model cepat utk task ringan (classify/safety verify) via 9router */
      fastModel: str(process.env.LLM_FAST_MODEL, ''),
      timeoutMs: num(process.env.LLM_FALLBACK_TIMEOUT_MS, 120_000),
      fastTimeoutMs: num(process.env.LLM_FAST_TIMEOUT_MS, 30_000),
    },
  },

  voice: {
    enabled: str(process.env.VOICE_ENABLED, 'true') === 'true',
    baseUrl: str(process.env.VOICE_BASE_URL, 'https://openrouter.ai/api/v1'),
    apiKey: str(process.env.VOICE_API_KEY, ''),
    model: str(process.env.VOICE_MODEL, 'deepgram/flux-tts:free'),
    voiceName: str(process.env.VOICE_NAME, 'flux-donovan-en'),
    format: str(process.env.VOICE_FORMAT, 'mp3'),
    /** text = default (teks saja); voice = voice-note via flag owner; both = teks + voice */
    mode: (['voice', 'text', 'both'].includes(str(process.env.VOICE_MODE, 'text'))
      ? str(process.env.VOICE_MODE, 'text')
      : 'text') as 'voice' | 'text' | 'both',
    timeoutMs: num(process.env.VOICE_TIMEOUT_MS, 120_000),
    maxChars: num(process.env.VOICE_MAX_CHARS, 1200),
  },

  rate: {
    windowMs: num(process.env.RATE_WINDOW_MS, 60_000),
    maxPerWindow: num(process.env.RATE_MAX_PER_WINDOW, 8),
  },

  resilience: {
    reconnectMaxAttempts: num(process.env.RECONNECT_MAX_ATTEMPTS, 5),
    sendMaxAttempts: num(process.env.SEND_MAX_ATTEMPTS, 3),
    sendBackoffBaseMs: num(process.env.SEND_BACKOFF_BASE_MS, 2000),
  },

  pipeline: {
    historyMessages: num(process.env.PIPELINE_HISTORY_MESSAGES, 12),
    memoryPerContact: num(process.env.PIPELINE_MEMORY_PER_CONTACT, 10),
  },

  logLevel: str(process.env.LOG_LEVEL, 'info'),
} as const;

export type AppConfig = typeof config;
