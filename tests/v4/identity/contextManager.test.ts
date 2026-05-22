/**
 * tests/v4/identity/contextManager.test.ts — v4.9.0 Slice 4.
 */
import { describe, it, expect } from 'vitest';
import {
  runWithContext,
  currentContext,
  requireContext,
} from '../../../core/v4/identity/contextManager';
import {
  newDaemonId,
  newIncarnationId,
  newRunId,
  newTraceId,
  newSpanId,
} from '../../../core/v4/identity/ids';
import type { ExecutionContext } from '../../../core/v4/identity/executionContext';

function makeCtx(): ExecutionContext {
  return {
    daemonId:      newDaemonId(),
    incarnationId: newIncarnationId(),
    runId:         newRunId(),
    traceId:       newTraceId(),
    spanId:        newSpanId(),
    source:        'cli',
    attempt:       0,
  };
}

describe('ContextManager (AsyncLocalStorage) — v4.9.0 Slice 4', () => {
  it('currentContext() is undefined outside runWithContext', () => {
    expect(currentContext()).toBeUndefined();
  });

  it('runWithContext exposes the ctx inside the closure', () => {
    const ctx = makeCtx();
    const inside = runWithContext(ctx, () => currentContext());
    expect(inside?.runId).toBe(ctx.runId);
    expect(inside?.daemonId).toBe(ctx.daemonId);
  });

  it('context unwinds after the closure returns', () => {
    const ctx = makeCtx();
    runWithContext(ctx, () => { /* noop */ });
    expect(currentContext()).toBeUndefined();
  });

  it('context survives across awaited continuations', async () => {
    const ctx = makeCtx();
    const out = await runWithContext(ctx, async () => {
      await new Promise<void>((r) => setImmediate(r));
      return currentContext();
    });
    expect(out?.runId).toBe(ctx.runId);
  });

  it('sibling runs do not see each other\'s contexts', async () => {
    const a = makeCtx();
    const b = makeCtx();
    const [outA, outB] = await Promise.all([
      runWithContext(a, async () => {
        await new Promise<void>((r) => setImmediate(r));
        return currentContext()?.runId;
      }),
      runWithContext(b, async () => {
        await new Promise<void>((r) => setImmediate(r));
        return currentContext()?.runId;
      }),
    ]);
    expect(outA).toBe(a.runId);
    expect(outB).toBe(b.runId);
  });

  it('nested runWithContext scopes correctly (inner shadows outer)', () => {
    const outer = makeCtx();
    const inner = makeCtx();
    const outRun = runWithContext(outer, () => {
      const before = currentContext()?.runId;
      const innerRun = runWithContext(inner, () => currentContext()?.runId);
      const after = currentContext()?.runId;
      return { before, innerRun, after };
    });
    expect(outRun.before).toBe(outer.runId);
    expect(outRun.innerRun).toBe(inner.runId);
    expect(outRun.after).toBe(outer.runId);
  });

  it('requireContext throws when no ambient context', () => {
    expect(() => requireContext()).toThrow(/no ambient ExecutionContext/);
  });

  it('requireContext throws with kind hint in message', () => {
    expect(() => requireContext('tool-dispatch')).toThrow(/required by: tool-dispatch/);
  });

  it('requireContext returns the ctx when present', () => {
    const ctx = makeCtx();
    const out = runWithContext(ctx, () => requireContext('test'));
    expect(out.runId).toBe(ctx.runId);
  });
});
