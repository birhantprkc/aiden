/**
 * tests/v4/aidenAgent.fallback.test.ts — Phase 16b.1
 *
 * Integration: when a FallbackAdapter is plugged into AidenAgent and the
 * first slot rate-limits, the second slot serves the call and the agent
 * loop terminates normally. This is the core 16b.1 fix in one test.
 */

import { describe, it, expect } from 'vitest';
import { AidenAgent } from '../../core/v4/aidenAgent';
import {
  FallbackAdapter,
  type ProviderSlot,
} from '../../core/v4/providerFallback';
import type { ProviderAdapter } from '../../providers/v4/types';

describe('AidenAgent integration with FallbackAdapter', () => {
  it('a 429 from slot 1 is silently retried via slot 2', async () => {
    const slot1Adapter: ProviderAdapter = {
      apiMode: 'chat_completions',
      call: async () => {
        throw new Error('Provider groq rate limited (HTTP 429)');
      },
    };
    const slot2Adapter: ProviderAdapter = {
      apiMode: 'chat_completions',
      call: async () => ({
        content: 'hello there',
        toolCalls: [],
        finishReason: 'stop',
        usage: { inputTokens: 4, outputTokens: 3 },
      }),
    };
    const slots: ProviderSlot[] = [
      {
        id: 'a',
        providerId: 'groq',
        modelId: 'm',
        keyPresent: true,
        keyTail: 'aaaa',
        build: () => slot1Adapter,
      },
      {
        id: 'b',
        providerId: 'groq',
        modelId: 'm',
        keyPresent: true,
        keyTail: 'bbbb',
        build: () => slot2Adapter,
      },
    ];

    const fa = new FallbackAdapter({
      apiMode: 'chat_completions',
      slots,
    });

    const agent = new AidenAgent({
      provider: fa,
      tools: [],
      toolExecutor: async () => ({ id: '0', name: 'noop', result: null }),
      maxTurns: 5,
    });

    const result = await agent.runConversation([
      { role: 'user', content: 'hi' },
    ]);
    expect(result.finalContent).toBe('hello there');
    expect(result.finishReason).toBe('stop');
    const diag = fa.getDiagnostics();
    expect(diag.activeSlotId).toBe('b');
    expect(diag.slots[0].state.rateLimitCount).toBe(1);
    expect(diag.slots[1].state.successCount).toBe(1);
  });
});
