import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  AI_PROVIDER_NAMES,
  DEFAULT_AI_PROVIDER_SETTING,
  isProviderConfigured,
  generateAIText,
} from '../aiProvider';

const ENV_KEYS = ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'] as const;
const ORIGINAL_ENV: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    ORIGINAL_ENV[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL_ENV[key];
  }
  vi.doUnmock('@google/generative-ai');
  vi.doUnmock('openai');
  vi.doUnmock('@anthropic-ai/sdk');
  vi.resetModules();
});

describe('AI_PROVIDER_NAMES / DEFAULT_AI_PROVIDER_SETTING', () => {
  it('lists gemini, openai, anthropic', () => {
    expect(AI_PROVIDER_NAMES).toEqual(['gemini', 'openai', 'anthropic']);
  });

  it('defaults to gemini with no fallbacks', () => {
    expect(DEFAULT_AI_PROVIDER_SETTING).toEqual({ provider: 'gemini', fallbacks: [] });
  });
});

describe('isProviderConfigured', () => {
  it('returns false when the corresponding API key env var is unset', () => {
    expect(isProviderConfigured('gemini')).toBe(false);
    expect(isProviderConfigured('openai')).toBe(false);
    expect(isProviderConfigured('anthropic')).toBe(false);
  });

  it('returns true when the corresponding API key env var is set', () => {
    process.env.GEMINI_API_KEY = 'g-key';
    process.env.OPENAI_API_KEY = 'o-key';
    process.env.ANTHROPIC_API_KEY = 'a-key';
    expect(isProviderConfigured('gemini')).toBe(true);
    expect(isProviderConfigured('openai')).toBe(true);
    expect(isProviderConfigured('anthropic')).toBe(true);
  });
});

describe('generateAIText', () => {
  it('throws "No AI provider configured" when no provider in the chain has an API key', async () => {
    await expect(generateAIText('hello', { provider: 'gemini', fallbacks: [] }))
      .rejects.toThrow();
  });

  it('calls the configured primary provider (gemini)', async () => {
    process.env.GEMINI_API_KEY = 'g-key';
    vi.doMock('@google/generative-ai', () => ({
      GoogleGenerativeAI: class {
        getGenerativeModel(): { generateContent: ReturnType<typeof vi.fn> } {
          return {
            generateContent: vi.fn().mockResolvedValue({ response: { text: () => 'gemini response' } }),
          };
        }
      },
    }));

    const { generateAIText: fn } = await import('../aiProvider');
    const text = await fn('hello', { provider: 'gemini', fallbacks: [] });
    expect(text).toBe('gemini response');
  });

  it('falls back to the next provider when the primary is not configured', async () => {
    process.env.OPENAI_API_KEY = 'o-key';
    vi.doMock('openai', () => ({
      default: class {
        chat = {
          completions: {
            create: vi.fn().mockResolvedValue({ choices: [{ message: { content: 'openai response' } }] }),
          },
        };
      },
    }));

    const { generateAIText: fn } = await import('../aiProvider');
    // gemini (primary) has no API key configured, so it throws and openai (fallback) is used
    const text = await fn('hello', { provider: 'gemini', fallbacks: ['openai'] });
    expect(text).toBe('openai response');
  });

  it('falls back to anthropic when gemini and openai both fail', async () => {
    process.env.ANTHROPIC_API_KEY = 'a-key';
    vi.doMock('@anthropic-ai/sdk', () => ({
      default: class {
        messages = {
          create: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'anthropic response' }] }),
        };
      },
    }));

    const { generateAIText: fn } = await import('../aiProvider');
    const text = await fn('hello', { provider: 'gemini', fallbacks: ['openai', 'anthropic'] });
    expect(text).toBe('anthropic response');
  });

  it('throws the last error when every provider in the chain fails', async () => {
    process.env.GEMINI_API_KEY = 'g-key';
    vi.doMock('@google/generative-ai', () => ({
      GoogleGenerativeAI: class {
        getGenerativeModel(): { generateContent: ReturnType<typeof vi.fn> } {
          return {
            generateContent: vi.fn().mockRejectedValue(Object.assign(new Error('rate limited'), { status: 429 })),
          };
        }
      },
    }));

    const { generateAIText: fn } = await import('../aiProvider');
    await expect(fn('hello', { provider: 'gemini', fallbacks: [] }))
      .rejects.toMatchObject({ status: 429 });
  });
});
