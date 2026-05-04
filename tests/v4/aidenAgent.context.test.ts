/**
 * Phase 13 integration: PromptBuilder + ContextCompressor + PromptCaching
 * + AuxiliaryClient wiring inside AidenAgent.runConversation.
 */
import { describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AidenAgent,
  type ToolExecutor,
} from '../../core/v4/aidenAgent';
import { MockProviderAdapter } from '../../core/v4/__mocks__/mockProvider';
import { PromptBuilder } from '../../core/v4/promptBuilder';
import { ContextCompressor } from '../../core/v4/contextCompressor';
import { ModelMetadata } from '../../core/v4/modelMetadata';
import { AuxiliaryClient } from '../../core/v4/auxiliaryClient';
import { PromptCaching } from '../../core/v4/promptCaching';
import type { AidenPaths } from '../../core/v4/paths';
import type {
  Message,
  ProviderAdapter,
  ProviderCallInput,
  ProviderCallOutput,
  ToolCallRequest,
  ToolSchema,
} from '../../providers/v4/types';

const NO_TOOLS: ToolSchema[] = [];
const okExecutor: ToolExecutor = async (call) => ({
  id: call.id,
  name: call.name,
  result: { ok: true },
});
const userMsg = (content: string): Message => ({ role: 'user', content });
const tc = (id: string, name: string): ToolCallRequest => ({
  id,
  name,
  arguments: {},
});

function makePaths(root: string): AidenPaths {
  return {
    root,
    sessionsDb: path.join(root, 'sessions.db'),
    authJson: path.join(root, 'auth.json'),
    configYaml: path.join(root, 'config.yaml'),
    envFile: path.join(root, '.env'),
    soulMd: path.join(root, 'SOUL.md'),
    memoryMd: path.join(root, 'MEMORY.md'),
    userMd: path.join(root, 'USER.md'),
    skillsDir: path.join(root, 'skills'),
  } as AidenPaths;
}

class FakeAuxAdapter implements ProviderAdapter {
  apiMode = 'chat_completions' as const;
  async call(): Promise<ProviderCallOutput> {
    return {
      content: 'AUX-SUMMARY',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 50, outputTokens: 30 },
    };
  }
}

describe('AidenAgent — Phase 13 context layers', () => {
  it('1. without context layers: existing behaviour unchanged', async () => {
    const provider = new MockProviderAdapter([
      MockProviderAdapter.stop('hi'),
    ]);
    const agent = new AidenAgent({
      provider,
      toolExecutor: okExecutor,
      tools: NO_TOOLS,
    });
    const r = await agent.runConversation([userMsg('hello')]);
    expect(r.finalContent).toBe('hi');
    expect(r.compressionEvents).toBe(0);
    expect(r.auxiliaryUsage).toEqual({});
  });

  it('2. promptBuilder builds system prompt at session start', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-pb-int-'));
    const provider = new MockProviderAdapter([MockProviderAdapter.stop('done')]);
    const pb = new PromptBuilder();
    const agent = new AidenAgent({
      provider,
      toolExecutor: okExecutor,
      tools: NO_TOOLS,
      promptBuilder: pb,
      promptBuilderOptions: {
        paths: makePaths(tmp),
        platform: 'linux',
        skipFilesystem: true,
      },
    });
    await agent.runConversation([userMsg('hi')]);
    const captured = provider.capturedInputs[0];
    // System message should now lead the messages array.
    expect(captured.messages[0].role).toBe('system');
    expect(captured.messages[0].content).toContain('You are Aiden');
  });

  it('3. systemPromptCached: subsequent runConversation reuses cached prompt', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-pb-cache-'));
    const provider = new MockProviderAdapter([
      MockProviderAdapter.stop('one'),
      MockProviderAdapter.stop('two'),
    ]);
    const pb = new PromptBuilder();
    const buildSpy = vi.spyOn(pb, 'build');
    const agent = new AidenAgent({
      provider,
      toolExecutor: okExecutor,
      tools: NO_TOOLS,
      promptBuilder: pb,
      promptBuilderOptions: {
        paths: makePaths(tmp),
        platform: 'linux',
        skipFilesystem: true,
      },
    });
    await agent.runConversation([userMsg('a')]);
    await agent.runConversation([userMsg('b')]);
    expect(buildSpy).toHaveBeenCalledTimes(1);
  });

  it('4. promptCaching: applyMarkers called for anthropic providerId', async () => {
    const provider = new MockProviderAdapter([MockProviderAdapter.stop('hi')]);
    const agent = new AidenAgent({
      provider,
      toolExecutor: okExecutor,
      tools: NO_TOOLS,
      promptCaching: new PromptCaching(),
      providerId: 'anthropic',
      modelId: 'claude-opus-4-7',
    });
    await agent.runConversation([
      { role: 'system', content: 'sys' },
      userMsg('hi'),
    ]);
    const captured = provider.capturedInputs[0];
    const sys = captured.messages.find((m) => m.role === 'system') as
      | (Message & { cache_control?: { type: string } })
      | undefined;
    expect(sys?.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('5. promptCaching no-op for non-anthropic provider', async () => {
    const provider = new MockProviderAdapter([MockProviderAdapter.stop('hi')]);
    const agent = new AidenAgent({
      provider,
      toolExecutor: okExecutor,
      tools: NO_TOOLS,
      promptCaching: new PromptCaching(),
      providerId: 'groq',
      modelId: 'llama-3.1-8b-instant',
    });
    await agent.runConversation([
      { role: 'system', content: 'sys' },
      userMsg('hi'),
    ]);
    const captured = provider.capturedInputs[0];
    const sys = captured.messages.find((m) => m.role === 'system') as
      | (Message & { cache_control?: unknown })
      | undefined;
    expect(sys?.cache_control).toBeUndefined();
  });

  it('6. contextCompressor fires when threshold hit', async () => {
    // Use a small-context model and stuff the message with varied tokens
    // (avoiding repeat-tokenizer compression).
    const provider = new MockProviderAdapter([MockProviderAdapter.stop('done')]);
    const md = new ModelMetadata();
    const aux = new AuxiliaryClient({
      defaultProvider: 'groq',
      defaultModel: 'llama-3.1-8b-instant',
      adapter: new FakeAuxAdapter(),
      warn: () => {},
    });
    const cc = new ContextCompressor(md, aux);
    const onCompression = vi.fn();
    const agent = new AidenAgent({
      provider,
      toolExecutor: okExecutor,
      tools: NO_TOOLS,
      contextCompressor: cc,
      providerId: 'ollama',
      modelId: 'gemma2:2b', // 8192 ctx
      onCompression,
    });
    // 30 messages of varied content; each ~600 chars of randomish tokens.
    const filler = 'The quick brown fox jumps over the lazy dog. ';
    const initial: Message[] = Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: filler.repeat(20) + ` msg-${i}`,
    }));
    const r = await agent.runConversation(initial);
    expect(r.compressionEvents).toBeGreaterThan(0);
    expect(onCompression).toHaveBeenCalled();
  }, 15000);

  it('7. compression result included in agent result (via auxiliaryUsage tracking)', async () => {
    const provider = new MockProviderAdapter([MockProviderAdapter.stop('done')]);
    const md = new ModelMetadata();
    const aux = new AuxiliaryClient({
      defaultProvider: 'groq',
      defaultModel: 'llama-3.1-8b-instant',
      adapter: new FakeAuxAdapter(),
      warn: () => {},
    });
    const cc = new ContextCompressor(md, aux);
    const agent = new AidenAgent({
      provider,
      toolExecutor: okExecutor,
      tools: NO_TOOLS,
      contextCompressor: cc,
      auxiliaryClient: aux,
      providerId: 'ollama',
      modelId: 'gemma2:2b',
    });
    const filler = 'The quick brown fox jumps over the lazy dog. ';
    const initial: Message[] = Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: filler.repeat(20) + ` msg-${i}`,
    }));
    const r = await agent.runConversation(initial);
    expect(r.auxiliaryUsage.compression).toBeDefined();
    expect(r.auxiliaryUsage.compression.calls).toBeGreaterThanOrEqual(1);
  }, 15000);

  it('8. iterationBudgetInjection appends snippet to last tool result in last 30%', async () => {
    // maxTurns=10. With remaining ≤ 30% meaning remaining ≤ 3 → turnCount ≥ 7.
    // Script: 6 tool_use turns, then on turn 7 a tool_use that triggers the
    // injection, then stop on turn 8.
    const provider = new MockProviderAdapter([
      MockProviderAdapter.toolUse([tc('t0', 'noop')]),
      MockProviderAdapter.toolUse([tc('t1', 'noop')]),
      MockProviderAdapter.toolUse([tc('t2', 'noop')]),
      MockProviderAdapter.toolUse([tc('t3', 'noop')]),
      MockProviderAdapter.toolUse([tc('t4', 'noop')]),
      MockProviderAdapter.toolUse([tc('t5', 'noop')]),
      MockProviderAdapter.toolUse([tc('t6', 'noop')]), // turn 7 → remaining 3 → inject
      MockProviderAdapter.stop('done'),
    ]);
    const agent = new AidenAgent({
      provider,
      toolExecutor: okExecutor,
      tools: NO_TOOLS,
      maxTurns: 10,
      iterationBudgetInjection: true,
    });
    const r = await agent.runConversation([userMsg('go')]);
    // Find the LAST tool message and verify the budget note was appended.
    const toolMessages = r.messages.filter((m) => m.role === 'tool');
    expect(toolMessages.length).toBeGreaterThan(0);
    const lastTool = toolMessages[toolMessages.length - 1];
    expect(lastTool.content).toContain('iteration budget');
    // Earlier tool messages should NOT carry the snippet.
    const firstTool = toolMessages[0];
    expect(firstTool.content).not.toContain('iteration budget');
  });

  it('9. iterationBudgetInjection disabled: no snippet appended', async () => {
    const provider = new MockProviderAdapter([
      MockProviderAdapter.toolUse([tc('t1', 'noop')]),
      MockProviderAdapter.stop('done'),
    ]);
    const agent = new AidenAgent({
      provider,
      toolExecutor: okExecutor,
      tools: NO_TOOLS,
      maxTurns: 2, // forces last 30%
      iterationBudgetInjection: false,
    });
    const r = await agent.runConversation([userMsg('go')]);
    const toolMsg = r.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).not.toContain('iteration budget');
  });

  it('10. all 4 layers compose with phase 12 moat (no interaction breakage)', async () => {
    const provider = new MockProviderAdapter([MockProviderAdapter.stop('done')]);
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-comp-'));
    const md = new ModelMetadata();
    const aux = new AuxiliaryClient({
      defaultProvider: 'groq',
      defaultModel: 'llama-3.1-8b-instant',
      adapter: new FakeAuxAdapter(),
      warn: () => {},
    });
    const cc = new ContextCompressor(md, aux);
    const pb = new PromptBuilder();
    const pcache = new PromptCaching();
    // No moat layers wired but agent should still produce all the new
    // result fields.
    const agent = new AidenAgent({
      provider,
      toolExecutor: okExecutor,
      tools: NO_TOOLS,
      promptBuilder: pb,
      promptBuilderOptions: {
        paths: makePaths(tmp),
        platform: 'linux',
        skipFilesystem: true,
      },
      contextCompressor: cc,
      auxiliaryClient: aux,
      promptCaching: pcache,
      providerId: 'groq',
      modelId: 'llama-3.1-8b-instant',
    });
    const r = await agent.runConversation([userMsg('hello')]);
    expect(r.finalContent).toBe('done');
    expect(r.compressionEvents).toBe(0);
    expect(typeof r.auxiliaryUsage).toBe('object');
  });
});
