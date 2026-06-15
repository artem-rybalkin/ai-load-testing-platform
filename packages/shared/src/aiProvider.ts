// ── Pluggable AI provider abstraction ──────────────────────────────────────
//
// Gemini remains the default provider (GEMINI_API_KEY/GEMINI_MODEL, as before).
// OpenAI and Anthropic (Claude) can be configured as the primary provider or
// as fallbacks, so a single provider outage/rate-limit no longer blocks the
// pipeline. Each provider reads its own API key/model from env vars and is
// skipped (treated as "not configured") when its API key is unset.

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
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({
    model: process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite',
  });
  const result = await model.generateContent(prompt);
  return result.response.text();
};

const callOpenAI = async (prompt: string): Promise<string> => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');
  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey });
  const result = await client.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
  });
  return result.choices[0]?.message?.content ?? '';
};

const callAnthropic = async (prompt: string): Promise<string> => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  const result = await client.messages.create({
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
 */
export async function generateAIText(prompt: string, opts: GenerateAITextOptions): Promise<string> {
  const chain = [opts.provider, ...(opts.fallbacks ?? [])];
  let lastErr: unknown = new Error('No AI provider configured');
  for (const provider of chain) {
    try {
      return await PROVIDER_CALLS[provider](prompt);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}
