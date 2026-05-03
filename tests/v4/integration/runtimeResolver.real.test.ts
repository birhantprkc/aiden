/**
 * End-to-end Phase 5 verification: registry → resolver → adapter → real LLM.
 *
 * Skips automatically when GROQ_API_KEY is unset, so CI without secrets
 * still passes. The whole point of this test is to prove the resolver
 * actually wires the chain correctly against a live provider.
 */
import { describe, it, expect } from 'vitest';
import { RuntimeResolver } from '../../../providers/v4/runtimeResolver';
import { CredentialResolver } from '../../../providers/v4/credentialResolver';

const GROQ_KEY = process.env.GROQ_API_KEY || process.env.GROQ_API_KEY_1;

describe.skipIf(!GROQ_KEY)('RuntimeResolver — real Groq via full resolution chain', () => {
  it('resolves groq + llama-3.3 → adapter → real call', async () => {
    if (GROQ_KEY) process.env.GROQ_API_KEY = GROQ_KEY;
    const resolver = new RuntimeResolver(new CredentialResolver());
    const adapter = await resolver.resolve({
      providerId: 'groq',
      modelId: 'llama-3.3-70b-versatile',
    });

    const result = await adapter.call({
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      tools: [],
      maxTokens: 10,
    });

    expect((result.content ?? '').toUpperCase()).toContain('OK');
    expect(result.finishReason).toBe('stop');
  }, 30_000);
});
