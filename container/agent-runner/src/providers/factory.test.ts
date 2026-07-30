import { describe, it, expect } from 'bun:test';

import { createProvider, type ProviderName } from './factory.js';
import { ClaudeProvider } from './claude.js';
import { MockProvider } from './mock.js';
import { OpenAIProvider } from './openai.js';

describe('createProvider', () => {
  it('returns ClaudeProvider for claude', () => {
    const provider = createProvider('claude');
    expect(provider).toBeInstanceOf(ClaudeProvider);
    expect(provider.loadsWorkspaceInstructionsNatively).toBe(true);
  });

  it('returns MockProvider for mock', () => {
    const provider = createProvider('mock');
    expect(provider).toBeInstanceOf(MockProvider);
    expect(provider.loadsWorkspaceInstructionsNatively).toBe(false);
  });

  it('marks OpenAI for provider-neutral workspace instruction expansion', () => {
    const provider = createProvider('openai');
    expect(provider).toBeInstanceOf(OpenAIProvider);
    expect(provider.loadsWorkspaceInstructionsNatively).toBe(false);
  });

  it('maps the opencode-go profile to the OpenAI-compatible provider', () => {
    expect(createProvider('opencode-go', { env: { OPENAI_API_KEY: 'test' } })).toBeInstanceOf(OpenAIProvider);
  });

  it('throws for unknown name', () => {
    expect(() => createProvider('bogus' as ProviderName)).toThrow(/Unknown provider/);
  });
});
