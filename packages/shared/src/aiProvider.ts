// ── Pluggable AI provider abstraction ──────────────────────────────────────
//
// Gemini remains the default provider (GEMINI_API_KEY/GEMINI_MODEL, as before).
// OpenAI and Anthropic (Claude) can be configured as the primary provider or
// as fallbacks, so a single provider outage/rate-limit no longer blocks the
// pipeline. Each provider reads its own API key/model from env vars and is
// skipped (treated as "not configured") when its API key is unset.

import { observe, updateActiveObservation } from '@langfuse/tracing';
import type OpenAI from 'openai';
import type Anthropic from '@anthropic-ai/sdk';
import { redactPII } from './index';

export type AiProviderName = 'gemini' | 'openai' | 'anthropic';

export const AI_PROVIDER_NAMES: AiProviderName[] = ['gemini', 'openai', 'anthropic'];

export interface AiProviderSetting {
  provider: AiProviderName;
  fallbacks: AiProviderName[];
}

export const DEFAULT_AI_PROVIDER_SETTING: AiProviderSetting = {
  provider: 'gemini',
  fallbacks: [],
};

/** Whether the given provider has its API key configured in env. */
export function isProviderConfigured(provider: AiProviderName): boolean {
  switch (provider) {
    case 'gemini': return !!process.env.GEMINI_API_KEY;
    case 'openai': return !!process.env.OPENAI_API_KEY;
    case 'anthropic': return !!process.env.ANTHROPIC_API_KEY;
    default: return false;
  }
}

const callGemini = async (prompt: string): Promise<string> => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');
  const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = await import('@google/generative-ai');
  const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({
    model: process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite',
    // Gemini 2.5+ defaults safety filtering to OFF — fenceUserContent() mitigates
    // prompt injection, but this is the only defense against a successfully
    // injected payload returning harmful executable code. BLOCK_ONLY_HIGH avoids
    // over-blocking legitimate load-test jargon (e.g. "attack", "exploit", "kill").
    safetySettings: [
      { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
    ],
  });
  const result = await model.generateContent(prompt);
  return result.response.text();
};

// Singletons, initialised lazily on first use. maxRetries: 0 because the outer
// retry loop in generateAIText/generateScript already retries on 429s with its
// own backoff — leaving each SDK's default maxRetries: 2 in place would let a
// single failed call silently retry up to 3x internally before the outer loop
// even sees the error, compounding into far more attempts than intended and
// making the outer loop's wait calculation blind to the time already spent.
// Per-call instantiation was also discarding TCP connection reuse between calls.
let openaiClient: OpenAI | null = null;
let anthropicClient: Anthropic | null = null;

const callOpenAI = async (prompt: string): Promise<string> => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');
  if (!openaiClient) {
    const { default: OpenAIClient } = await import('openai');
    openaiClient = new OpenAIClient({ apiKey, maxRetries: 0 });
  }
  const result = await openaiClient.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    max_tokens: 8192,
    messages: [{ role: 'user', content: prompt }],
  });
  return result.choices[0]?.message?.content ?? '';
};

const callAnthropic = async (prompt: string): Promise<string> => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');
  if (!anthropicClient) {
    const { default: AnthropicClient } = await import('@anthropic-ai/sdk');
    anthropicClient = new AnthropicClient({ apiKey, maxRetries: 0 });
  }
  const result = await anthropicClient.messages.create({
    model: process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-latest',
    max_tokens: 8192,
    messages: [{ role: 'user', content: prompt }],
  });
  const block = result.content[0];
  return block && block.type === 'text' ? block.text : '';
};

const PROVIDER_CALLS: Record<AiProviderName, (prompt: string) => Promise<string>> = {
  gemini: callGemini,
  openai: callOpenAI,
  anthropic: callAnthropic,
};

export interface GenerateAITextOptions {
  provider: AiProviderName;
  fallbacks?: AiProviderName[];
}

/**
 * Generates text via the primary provider, falling back (in order) to any
 * configured fallback providers if the primary fails or isn't configured.
 * Throws the last encountered error (preserving e.g. `.status` for 429
 * handling) if every provider in the chain fails.
 *
 * Wrapped with observe() so every call from every service (script generation,
 * the chat endpoint, AI insights, recorder correlation, etc.) is traced as an
 * LLM "generation" node in one place, instead of instrumenting ~20 call sites
 * individually. observe() is a no-op when no OTel SDK/LangfuseSpanProcessor is
 * registered (e.g. in tests, or when LANGFUSE_* env vars are unset) — see each
 * service's tracing.ts for where the processor is conditionally added.
 */
export const generateAIText = observe(
  async function generateAIText(prompt: string, opts: GenerateAITextOptions): Promise<string> {
    // captureInput: false below stops observe() from auto-capturing the raw
    // `prompt` argument as trace input — it can contain user-supplied test
    // descriptions, step URLs/bodies, and (via the recorder flow) auth header
    // values, all wrapped by fenceUserContent() but none filtered by redactPII().
    // Set a redacted copy explicitly instead so traces stay useful without
    // leaking that content to Langfuse. The real `prompt` (unredacted) is still
    // what's actually sent to the LLM below — only the trace copy is redacted.
    updateActiveObservation({ input: redactPII(prompt) });
    const chain = [opts.provider, ...(opts.fallbacks ?? [])];
    let lastErr: unknown = new Error('No AI provider configured');
    for (const provider of chain) {
      try {
        const text = await PROVIDER_CALLS[provider](prompt);
        updateActiveObservation({ metadata: { provider, fallbacksConfigured: opts.fallbacks ?? [] } });
        return text;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  },
  { name: 'generateAIText', asType: 'generation', captureInput: false }
);
