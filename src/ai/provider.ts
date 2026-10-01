import type { Redactor } from '../shared/redactor.js';

export interface AIRequest {
  system: string;
  user: string;
  /** Extra conversation turns (used to feed validation errors back for one retry). */
  history?: { role: 'user' | 'assistant'; content: string }[];
  /** Base64 PNGs; only sent when config.ai.sendScreenshots is true. */
  images?: string[];
  maxTokens?: number;
  json?: boolean;
}
export interface AIResponse { text: string; usage?: { promptTokens?: number; completionTokens?: number } }

/** Provider abstraction. Adapters hold the API key; nothing outside the adapter ever sees it. */
export interface AIProvider {
  readonly name: string;
  readonly model: string;
  complete(req: AIRequest, signal?: AbortSignal): Promise<AIResponse>;
}

export class AIProviderError extends Error {
  constructor(message: string, readonly status?: number, readonly retryable = false) { super(message); this.name = 'AIProviderError'; }
}

export interface OpenAICompatibleOptions {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  redactor: Redactor;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
}

/** Works with OpenAI, Groq, Gemini (OpenAI-compatible endpoint), Together, vLLM, Ollama... anything speaking /chat/completions. */
export class OpenAICompatibleProvider implements AIProvider {
  readonly name: string; readonly model: string;
  private readonly o: OpenAICompatibleOptions;
  constructor(o: OpenAICompatibleOptions) {
    this.o = o; this.name = o.name; this.model = o.model;
    o.redactor.register(o.apiKey); // the key can never reach logs/DB/reports
  }

  async complete(req: AIRequest, signal?: AbortSignal): Promise<AIResponse> {
    const useJsonFormat = req.json !== false;
    try { return await this.send(req, useJsonFormat, signal); } catch (e) {
      // Some endpoints reject response_format; retry once without it.
      if (useJsonFormat && e instanceof AIProviderError && e.status === 400 && /response_format|json/i.test(e.message)) return this.send(req, false, signal);
      throw e;
    }
  }

  private async send(req: AIRequest, jsonFormat: boolean, signal?: AbortSignal): Promise<AIResponse> {
    const doFetch = this.o.fetchImpl ?? fetch;
    const userContent = req.images?.length
      ? [{ type: 'text', text: req.user }, ...req.images.map((b64) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }))]
      : req.user;
    const body: Record<string, unknown> = {
      model: this.model, temperature: 0, max_tokens: req.maxTokens ?? 2500,
      messages: [{ role: 'system', content: req.system }, { role: 'user', content: userContent }, ...(req.history ?? [])],
    };
    if (jsonFormat) body.response_format = { type: 'json_object' };

    const retries = this.o.maxRetries ?? 2;
    let lastErr: AIProviderError | undefined;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.o.timeoutMs ?? 60_000);
      signal?.addEventListener('abort', () => ctrl.abort(), { once: true });
      try {
        const res = await doFetch(`${this.o.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST', signal: ctrl.signal,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.o.apiKey}` },
          body: JSON.stringify(body),
        });
        const raw = await res.text();
        if (!res.ok) {
          const retryable = res.status === 429 || res.status >= 500;
          lastErr = new AIProviderError(this.o.redactor.redact(`${this.name} HTTP ${res.status}: ${raw.slice(0, 300)}`), res.status, retryable);
          if (!retryable || attempt === retries) throw lastErr;
        } else {
          const json = JSON.parse(raw) as { choices?: { message?: { content?: string | null } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
          const text = json.choices?.[0]?.message?.content ?? '';
          return { text, usage: { promptTokens: json.usage?.prompt_tokens, completionTokens: json.usage?.completion_tokens } };
        }
      } catch (e) {
        if (e instanceof AIProviderError) { if (!e.retryable || attempt === retries) throw e; lastErr = e; } else {
          const msg = this.o.redactor.redact(e instanceof Error ? e.message : String(e));
          lastErr = new AIProviderError(`${this.name} request failed: ${msg}`, undefined, true);
          if (attempt === retries) throw lastErr;
        }
      } finally { clearTimeout(timer); }
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
    throw lastErr ?? new AIProviderError('unknown provider failure');
  }
}

/** Scriptable provider for tests: no network. Records every request. */
export class MockProvider implements AIProvider {
  readonly name = 'mock'; readonly model = 'mock-1';
  readonly calls: AIRequest[] = [];
  constructor(private readonly handler: (req: AIRequest, callIndex: number) => string | Promise<string>) {}
  async complete(req: AIRequest): Promise<AIResponse> {
    const i = this.calls.push(req) - 1;
    return { text: await this.handler(req, i) };
  }
}

const PRESETS: Record<string, { baseUrl: string; model: string }> = {
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash' },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
};

/**
 * Builds a provider from server-side environment variables (never from the UI):
 *   QA_AI_PROVIDER = gemini | groq | openai | openai-compatible
 *   QA_AI_API_KEY, QA_AI_MODEL (optional), QA_AI_BASE_URL (required for openai-compatible)
 * Returns null when AI is not configured.
 */
export function createProviderFromEnv(redactor: Redactor, env: NodeJS.ProcessEnv = process.env): AIProvider | null {
  const kind = env.QA_AI_PROVIDER?.toLowerCase();
  const apiKey = env.QA_AI_API_KEY;
  if (!kind || !apiKey) return null;
  if (apiKey) redactor.register(apiKey);
  const preset = PRESETS[kind];
  const baseUrl = env.QA_AI_BASE_URL ?? preset?.baseUrl;
  if (!baseUrl) throw new Error(`QA_AI_PROVIDER=${kind} requires QA_AI_BASE_URL`);
  const model = env.QA_AI_MODEL ?? preset?.model;
  if (!model) throw new Error(`QA_AI_PROVIDER=${kind} requires QA_AI_MODEL`);
  return new OpenAICompatibleProvider({ name: kind, baseUrl, apiKey, model, redactor });
}
