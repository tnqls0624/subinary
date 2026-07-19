import { afterEach, describe, expect, it, vi } from 'vitest';

import { createProviders } from './factory.js';
import { MockEmbeddingProvider, MockLlmProvider, MockRerankerProvider } from './mocks.js';
import { OpenAiEmbeddingProvider } from './openai.js';

describe('createProviders', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('defaults to deterministic mock providers', () => {
    const set = createProviders();
    expect(set.llm).toBeInstanceOf(MockLlmProvider);
    expect(set.embedding).toBeInstanceOf(MockEmbeddingProvider);
    expect(set.reranker).toBeInstanceOf(MockRerankerProvider);
    expect(set.embedding.dimensions).toBe(256);
    expect(set.embedding.model).toBe('mock');
  });

  it('returns mock for provider="mock"', () => {
    const set = createProviders({ provider: 'mock' });
    expect(set.embedding).toBeInstanceOf(MockEmbeddingProvider);
  });

  it('falls back to mock (with warning) when openai has no API key', () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const set = createProviders({ provider: 'openai' });
    expect(set.embedding).toBeInstanceOf(MockEmbeddingProvider);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('wires the OpenAI embedding skeleton (256-dim) when a key is provided', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const set = createProviders({ provider: 'openai', openaiApiKey: 'sk-test' });
    expect(set.embedding).toBeInstanceOf(OpenAiEmbeddingProvider);
    expect(set.embedding.dimensions).toBe(256);
    // llm/reranker는 여전히 Mock (스켈레톤 경로).
    expect(set.llm).toBeInstanceOf(MockLlmProvider);
    expect(set.reranker).toBeInstanceOf(MockRerankerProvider);
  });

  it('falls back to mock for anthropic and unknown providers', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(createProviders({ provider: 'anthropic' }).embedding).toBeInstanceOf(MockEmbeddingProvider);
    expect(createProviders({ provider: 'google' }).embedding).toBeInstanceOf(MockEmbeddingProvider);
    expect(createProviders({ provider: 'nope' }).embedding).toBeInstanceOf(MockEmbeddingProvider);
  });

  it('fails closed for mock, missing credentials and partial providers in strict mode', () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    expect(() => createProviders({ provider: 'mock', strict: true })).toThrow(
      /strict mode/,
    );
    expect(() => createProviders({ provider: 'gemini', strict: true })).toThrow(
      /no API key/,
    );
    expect(() =>
      createProviders({
        provider: 'openai',
        openaiApiKey: 'sk-test',
        strict: true,
      }),
    ).toThrow(/partial/);
    expect(() =>
      createProviders({
        provider: 'anthropic',
        anthropicApiKey: 'anthropic-test',
        strict: true,
      }),
    ).toThrow(/not implemented/);
    expect(() => createProviders({ provider: 'unknown', strict: true })).toThrow(
      /unknown/,
    );
  });

  it('allows configured Gemini in strict mode without silent fallback', () => {
    const set = createProviders({
      provider: 'gemini',
      geminiApiKey: 'gemini-test',
      strict: true,
    });
    expect(set.llm.provider).toBe('gemini');
    expect(set.embedding.provider).toBe('mock');
    expect(set.reranker.provider).toBe('mock');
  });
});
