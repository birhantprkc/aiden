import { describe, test, expect, vi, beforeEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import {
  checkProviderLiveness,
  enumerateConfiguredProviders,
  runProviderLiveness,
  renderProviderLivenessSection,
  type LivenessResult,
  type LivenessSummary,
} from '../../../cli/v4/doctorLiveness';
import type { ProviderAdapter } from '../../../providers/v4/types';
import type { AidenPaths } from '../../../core/v4/paths';

/**
 * Phase v4.1.1-oauth-fix Phase 4 — provider liveness deep check.
 *
 * Contract under test:
 *   - Green probe returns latency + model, no error
 *   - Red probe captures err.message VERBATIM (truncated to 200 chars)
 *   - Hard timeout produces a red result with "timeout after Nms"
 *   - Unconfigured providers are 'skipped' with skip_reason — no
 *     network call attempted (probes are not the place to discover
 *     missing API keys)
 *   - Parallel mode runs probes concurrently (default)
 *   - Summary tallies match the result counts
 *   - Renderer produces deterministic output independent of terminal width
 */

const fakePaths: AidenPaths = {
  root:       '/tmp/aiden-test',
  authJson:   '/tmp/aiden-test/auth.json',
  envFile:    '/tmp/aiden-test/.env',
  sessionsDb: '/tmp/aiden-test/sessions.db',
  skillsDir:  '/tmp/aiden-test/skills',
  logsDir:    '/tmp/aiden-test/logs',
  bundledManifest: '/tmp/aiden-test/.bundled_manifest',
} as unknown as AidenPaths;

function stubAdapter(behaviour: 'ok' | 'throw' | 'slow', errMsg?: string): ProviderAdapter {
  return {
    apiMode: 'chat_completions' as const,
    async call(_input) {
      if (behaviour === 'throw') throw new Error(errMsg ?? 'boom');
      if (behaviour === 'slow') {
        await new Promise((r) => setTimeout(r, 50_000));
        return { content: 'never', toolCalls: [], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
      }
      return { content: 'pong', toolCalls: [], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
}

describe('checkProviderLiveness', () => {
  test('green on successful adapter.call', async () => {
    const result = await checkProviderLiveness('groq', 'llama-3.3-70b', stubAdapter('ok'));
    expect(result.status).toBe('green');
    expect(result.provider).toBe('groq');
    expect(result.model).toBe('llama-3.3-70b');
    expect(result.error).toBeUndefined();
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
  });

  test('red captures err.message verbatim', async () => {
    const upstream = `Provider chatgpt-plus request failed (400): Invalid schema for function 'subagent_fanout': In context=('properties', 'tasks'), array schema missing items.`;
    const result = await checkProviderLiveness('chatgpt-plus', 'gpt-5.5', stubAdapter('throw', upstream));
    expect(result.status).toBe('red');
    expect(result.error).toBe(upstream);
    expect(result.error).toContain('subagent_fanout');
    expect(result.error).toContain('array schema missing items');
  });

  test('red truncates long error messages to ≤200 chars with ellipsis', async () => {
    const longErr = 'X'.repeat(500);
    const result = await checkProviderLiveness('test', 'm', stubAdapter('throw', longErr));
    expect(result.status).toBe('red');
    expect(result.error!.length).toBeLessThanOrEqual(200);
    expect(result.error).toMatch(/…$/);
  });

  test('red on timeout', async () => {
    const result = await checkProviderLiveness('test', 'm', stubAdapter('slow'), { timeoutMs: 50 });
    expect(result.status).toBe('red');
    expect(result.error).toContain('timeout');
    expect(result.error).toContain('50ms');
  });
});

describe('enumerateConfiguredProviders', () => {
  test('API-key provider with env var set → configured', async () => {
    const out = await enumerateConfiguredProviders({
      paths:     fakePaths,
      env:       { GROQ_API_KEY: 'gsk_test' } as NodeJS.ProcessEnv,
      fetchImpl: () => Promise.reject(new Error('ollama not running')) as any,
    });
    const groq = out.find((p) => p.entry.id === 'groq');
    expect(groq?.configured).toBe(true);
    expect(groq?.model).toBe(groq?.entry.modelIds[0]);
  });

  test('API-key provider with env var missing → skipped with reason', async () => {
    const out = await enumerateConfiguredProviders({
      paths:     fakePaths,
      env:       {} as NodeJS.ProcessEnv,
      fetchImpl: () => Promise.reject(new Error('ollama not running')) as any,
    });
    const groq = out.find((p) => p.entry.id === 'groq');
    expect(groq?.configured).toBe(false);
    expect(groq?.reason).toContain('GROQ_API_KEY');
  });

  test('OAuth provider with no token → skipped with login hint', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-liveness-'));
    const paths = { ...fakePaths, root: tmpRoot, authJson: path.join(tmpRoot, 'auth.json') };
    try {
      const out = await enumerateConfiguredProviders({
        paths,
        env:       {} as NodeJS.ProcessEnv,
        fetchImpl: () => Promise.reject(new Error('ollama not running')) as any,
      });
      const cgpt = out.find((p) => p.entry.id === 'chatgpt-plus');
      expect(cgpt?.configured).toBe(false);
      expect(cgpt?.reason).toMatch(/auth login|no OAuth/i);
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test('Ollama probe ok → configured', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const out = await enumerateConfiguredProviders({
      paths:     fakePaths,
      env:       {} as NodeJS.ProcessEnv,
      fetchImpl: fetchImpl as any,
    });
    const ollama = out.find((p) => p.entry.id === 'ollama');
    expect(ollama?.configured).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/api/tags',
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  test('Ollama probe fails → skipped with reason', async () => {
    const out = await enumerateConfiguredProviders({
      paths:     fakePaths,
      env:       {} as NodeJS.ProcessEnv,
      fetchImpl: (() => Promise.reject(new Error('ECONNREFUSED'))) as any,
    });
    const ollama = out.find((p) => p.entry.id === 'ollama');
    expect(ollama?.configured).toBe(false);
    expect(ollama?.reason).toContain('11434');
  });
});

describe('runProviderLiveness', () => {
  test('skipped providers cost zero network — adapter never resolved', async () => {
    const resolve = vi.fn();
    const result = await runProviderLiveness({
      paths:        fakePaths,
      env:          {} as NodeJS.ProcessEnv,
      fetchImpl:    (() => Promise.reject(new Error('ollama not running'))) as any,
      resolverImpl: { resolve: resolve as any },
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(result.summary.green).toBe(0);
    expect(result.summary.red).toBe(0);
    expect(result.summary.skipped).toBeGreaterThan(0);
    for (const r of result.results) {
      expect(r.status).toBe('skipped');
    }
  });

  test('happy path: configured provider → green', async () => {
    const resolve = vi.fn().mockResolvedValue(stubAdapter('ok'));
    const result = await runProviderLiveness({
      paths:        fakePaths,
      env:          { GROQ_API_KEY: 'gsk_test' } as NodeJS.ProcessEnv,
      fetchImpl:    (() => Promise.reject(new Error('ollama not running'))) as any,
      resolverImpl: { resolve: resolve as any },
    });
    const groq = result.results.find((r) => r.provider === 'groq');
    expect(groq?.status).toBe('green');
    expect(result.summary.green).toBeGreaterThanOrEqual(1);
    expect(result.summary.total_ms).toBeGreaterThanOrEqual(0);
  });

  test('adapter throw bubbles up as red with full upstream message', async () => {
    const upstream = `Provider chatgpt-plus request failed (400): Invalid schema for function 'subagent_fanout': In context=('properties', 'tasks'), array schema missing items.`;
    const resolve = vi.fn().mockResolvedValue(stubAdapter('throw', upstream));
    const result = await runProviderLiveness({
      paths:        fakePaths,
      env:          { GROQ_API_KEY: 'gsk_test' } as NodeJS.ProcessEnv,
      fetchImpl:    (() => Promise.reject(new Error('ollama not running'))) as any,
      resolverImpl: { resolve: resolve as any },
    });
    const groq = result.results.find((r) => r.provider === 'groq');
    expect(groq?.status).toBe('red');
    expect(groq?.error).toContain('subagent_fanout');
    expect(result.summary.red).toBeGreaterThanOrEqual(1);
  });

  test('parallel mode: 3× 200ms probes complete in <500ms wall-clock', async () => {
    const slowAdapter: ProviderAdapter = {
      apiMode: 'chat_completions' as const,
      async call() {
        await new Promise((r) => setTimeout(r, 200));
        return { content: 'ok', toolCalls: [], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const resolve = vi.fn().mockResolvedValue(slowAdapter);
    const start = Date.now();
    await runProviderLiveness({
      paths:        fakePaths,
      env:          {
        GROQ_API_KEY:     'x',
        TOGETHER_API_KEY: 'x',
        OPENROUTER_API_KEY: 'x',
      } as NodeJS.ProcessEnv,
      fetchImpl:    (() => Promise.reject(new Error('ollama not running'))) as any,
      resolverImpl: { resolve: resolve as any },
      parallel:     true,
    });
    const elapsed = Date.now() - start;
    // Three configured providers, each takes 200ms → parallel ≤ ~300ms,
    // sequential would be ≥ 600ms. Generous ceiling for CI jitter.
    expect(elapsed).toBeLessThan(500);
  });

  test('resolver failure is captured as red, not as a thrown exception', async () => {
    const resolve = vi.fn().mockRejectedValue(new Error('credential missing'));
    const result = await runProviderLiveness({
      paths:        fakePaths,
      env:          { GROQ_API_KEY: 'gsk_test' } as NodeJS.ProcessEnv,
      fetchImpl:    (() => Promise.reject(new Error('ollama not running'))) as any,
      resolverImpl: { resolve: resolve as any },
    });
    const groq = result.results.find((r) => r.provider === 'groq');
    expect(groq?.status).toBe('red');
    expect(groq?.error).toContain('credential missing');
  });
});

describe('renderProviderLivenessSection', () => {
  test('contains section header, separator, and summary line', () => {
    const results: LivenessResult[] = [
      { provider: 'groq',         model: 'llama-3.3-70b', status: 'green', latency_ms: 340 },
      { provider: 'chatgpt-plus', model: 'gpt-5.5',       status: 'red',   latency_ms: 820, error: '400: Invalid schema for function subagent_fanout' },
      { provider: 'ollama',                                status: 'skipped', latency_ms: 0, skip_reason: 'not running on http://127.0.0.1:11434' },
    ];
    const summary: LivenessSummary = { green: 1, red: 1, skipped: 1, total_ms: 1850 };
    const out = renderProviderLivenessSection(results, summary);
    expect(out).toContain('Provider liveness (deep check)');
    expect(out).toContain('✓ groq');
    expect(out).toContain('✗ chatgpt-plus');
    expect(out).toContain('- ollama');
    expect(out).toContain('1 green · 1 red · 1 skipped · 1850ms total');
    expect(out).toContain('Invalid schema for function subagent_fanout');
  });

  test('green rows show model id; red rows show error; skipped rows show reason', () => {
    const out = renderProviderLivenessSection(
      [
        { provider: 'a', model: 'modelA', status: 'green', latency_ms: 10 },
        { provider: 'b', model: 'modelB', status: 'red',   latency_ms: 20, error: 'boom' },
        { provider: 'c',                  status: 'skipped', latency_ms: 0, skip_reason: 'no creds' },
      ],
      { green: 1, red: 1, skipped: 1, total_ms: 30 },
    );
    expect(out).toMatch(/✓ a\s+green.+modelA/);
    expect(out).toMatch(/✗ b\s+red.+boom/);
    expect(out).toMatch(/- c\s+skip.+no creds/);
  });
});
