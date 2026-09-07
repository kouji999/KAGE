// LLM client — satu-satunya gerbang ke LLM untuk semua stage pipeline (T7).
// Budget guard bulanan + retry (2x, backoff 2s) + usage accounting.

import { config } from '../../config/index.js';
import { childLogger } from '../../config/logger.js';
import { LlmUsageRepository } from '../../storage/index.js';

const log = childLogger('llm');

const MAX_ATTEMPTS = 3; // 1 awal + 2 retry
const RETRY_BACKOFF_MS = 2_000;
/** Estimasi konservatif USD per 1M token — model free, tapi volume tetap dilacak. */
const USD_PER_MTOKEN = 0.35;

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  purpose: string;
  temperature?: number;
  /**
   * Hint JSON output. NOTE: GLM-5.3 (verified empirik 2026-09-06) menolak
   * `response_format` — jadi ini TIDAK dikirim ke API; JSON didapat via prompt
   * + `parseLlmJson()` tolerant extraction di stage.
   */
  json?: boolean;
  maxTokens?: number;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string | null; reasoning_content?: string | null };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface ProviderSpec {
  name: 'primary' | 'backup';
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

/** GLM-5.3 reasoning model kadang menyisipkan <think> blok inline di content. */
function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

/**
 * Parse response JSON toleran — 9router (verified empirik 2026-09-07) kadang
 * menempelkan sisa SSE `data: [DONE]` di akhir body non-stream.
 */
function parseCompletionJson(text: string): ChatCompletionResponse {
  try {
    return JSON.parse(text) as ChatCompletionResponse;
  } catch {
    const m = /\{[\s\S]*\}/.exec(text);
    if (!m) throw new Error(`LLM returned invalid JSON: ${text.slice(0, 300)}`);
    return JSON.parse(m[0]) as ChatCompletionResponse;
  }
}

export class LlmClient {
  /**
   * Kirim chat completion. Throw BudgetExceededError saat budget habis —
   * caller WAJIB catch dan degrade gracefully (hold, jangan crash).
   *
   * GLM-5.3 = reasoning model (verified empirik): reasoning dipisah ke
   * `reasoning_content`, `content` bisa null saat max_tokens habis di tengah
   * reasoning (finish_reason=length) → retry otomatis dengan max_tokens lebih besar.
   *
   * Chain provider: primary → backup (9router) kalau primary gagal total.
   */
  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<string> {
    const purpose = opts?.purpose ?? 'chat';
    this.assertBudget();

    const providers: ProviderSpec[] = [
      {
        name: 'primary',
        baseUrl: config.llm.baseUrl,
        apiKey: config.llm.apiKey,
        model: config.llm.model,
        timeoutMs: config.llm.timeoutMs,
      },
    ];
    const fb = config.llm.fallback;
    if (fb.baseUrl !== '' && fb.model !== '' && fb.apiKey !== '') {
      providers.push({ name: 'backup', baseUrl: fb.baseUrl, apiKey: fb.apiKey, model: fb.model, timeoutMs: fb.timeoutMs });
    }

    let lastErr: unknown;
    for (const p of providers) {
      try {
        return await this.chatWith(p, messages, opts);
      } catch (err) {
        if (err instanceof BudgetExceededError) throw err;
        lastErr = err;
        if (p.name === 'primary' && providers.length > 1) {
          log.warn(
            { purpose, provider: p.name, err: errMsg(err) },
            'primary LLM gagal — fallback ke backup provider',
          );
        }
      }
    }
    throw new Error(`all LLM providers failed: ${errMsg(lastErr)}`);
  }

  private async chatWith(
    p: ProviderSpec,
    messages: ChatMessage[],
    opts?: ChatOptions,
  ): Promise<string> {
    const purpose = opts?.purpose ?? 'chat';
    let maxTokens = opts?.maxTokens ?? config.llm.maxTokens;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const payload = {
        model: p.model,
        messages,
        temperature: opts?.temperature ?? 0.7,
        max_tokens: maxTokens,
      };

      let res: Response;
      try {
        res = await fetch(`${p.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${p.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(p.timeoutMs),
        });
      } catch (err) {
        // network / DNS / abort
        if (attempt < MAX_ATTEMPTS) {
          log.warn({ purpose, provider: p.name, attempt, err: errMsg(err) }, 'llm network error, retrying');
          await sleep(RETRY_BACKOFF_MS);
          continue;
        }
        throw new Error(`LLM(${p.name}) network error after ${MAX_ATTEMPTS} attempts: ${errMsg(err)}`);
      }

      const text = await res.text();

      if (!res.ok) {
        if (res.status >= 500 && attempt < MAX_ATTEMPTS) {
          log.warn({ purpose, provider: p.name, attempt, status: res.status }, 'llm 5xx, retrying');
          await sleep(RETRY_BACKOFF_MS);
          continue;
        }
        throw new Error(`LLM(${p.name}) API ${res.status}: ${text.slice(0, 500)}`);
      }

      const data = parseCompletionJson(text);
      const choice = data.choices?.[0];
      let content = choice?.message?.content;
      const reasoning = choice?.message?.reasoning_content;
      const finish = choice?.finish_reason;

      if (content == null || content.trim() === '') {
        if (finish === 'length' && attempt < MAX_ATTEMPTS) {
          // reasoning makan seluruh budget sebelum jawaban tercetak — naikkan token
          maxTokens = Math.min(maxTokens * 2, 4000);
          log.warn(
            { purpose, provider: p.name, attempt, maxTokens },
            'content kosong (finish=length, reasoning) — retry max_tokens lebih besar',
          );
          await sleep(RETRY_BACKOFF_MS);
          continue;
        }
        if (typeof reasoning === 'string' && reasoning.trim() !== '') {
          // last resort: jawaban JSON kadang ada di dalam reasoning — stage parse dengan parseLlmJson
          content = reasoning;
        } else {
          throw new Error(`LLM(${p.name}) response missing content: ${text.slice(0, 300)}`);
        }
      }

      const inputTokens = data.usage?.prompt_tokens ?? 0;
      const outputTokens = data.usage?.completion_tokens ?? 0;
      const estCostUsd = ((inputTokens + outputTokens) / 1_000_000) * USD_PER_MTOKEN;
      LlmUsageRepository.add(purpose, p.model, inputTokens, outputTokens, estCostUsd);
      if (p.name === 'backup') log.info({ purpose }, 'llm call terlayani via BACKUP provider');

      return stripThink(content);
    }

    throw new Error(`unreachable: llm(${p.name}) retry loop exited`);
  }

  /** Health check murah: GET /models, timeout 10s. */
  async healthy(): Promise<boolean> {
    try {
      const res = await fetch(`${config.llm.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${config.llm.apiKey}` },
        signal: AbortSignal.timeout(10_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private assertBudget(): void {
    const summary = LlmUsageRepository.monthlySummary();
    if (summary.estCostUsd >= config.llm.monthlyBudgetUsd) {
      throw new BudgetExceededError(
        `LLM monthly budget exceeded: est $${summary.estCostUsd.toFixed(4)} >= $${config.llm.monthlyBudgetUsd}`,
      );
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const llm = new LlmClient();
