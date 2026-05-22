/**
 * tests/v4/identity/executionContext.test.ts — v4.9.0 Slice 4.
 */
import { describe, it, expect } from 'vitest';
import {
  serializeContext,
  deserializeContext,
  childSpan,
  type ExecutionContext,
} from '../../../core/v4/identity/executionContext';
import {
  newDaemonId,
  newIncarnationId,
  newRunId,
  newTraceId,
  newSpanId,
  newTriggerId,
} from '../../../core/v4/identity/ids';

function makeCtx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    daemonId:      newDaemonId(),
    incarnationId: newIncarnationId(),
    runId:         newRunId(),
    traceId:       newTraceId(),
    spanId:        newSpanId(),
    source:        'cli',
    attempt:       0,
    ...overrides,
  };
}

describe('ExecutionContext (de)serialize — v4.9.0 Slice 4', () => {
  it('roundtrips a minimal context', () => {
    const ctx = makeCtx();
    const s = serializeContext(ctx);
    const out = deserializeContext(s);
    expect(out).toEqual(ctx);
  });

  it('roundtrips a fully-populated context', () => {
    const ctx = makeCtx({
      parentSpanId:      newSpanId(),
      requestId:         'req_123',
      externalRequestId: 'ext-X-Request-Id-abc',
      triggerId:         newTriggerId(),
      sessionId:         'session-42',
      source:            'webhook',
      attempt:           3,
      deadlineAt:        '2026-05-22T12:00:00.000Z',
      baggage:           { tenant: 'acme', region: 'us-east' },
    });
    const out = deserializeContext(serializeContext(ctx));
    expect(out).toEqual(ctx);
  });

  it('omits undefined optional fields in the serialised payload', () => {
    const ctx = makeCtx();
    const json = JSON.parse(serializeContext(ctx)) as Record<string, unknown>;
    expect(Object.keys(json)).toEqual(['d', 'i', 'r', 't', 's', 'sr', 'a']);
  });

  it('rejects malformed JSON', () => {
    expect(() => deserializeContext('not-json')).toThrow(/invalid JSON/);
  });

  it('rejects missing required fields', () => {
    expect(() => deserializeContext('{"d":"dmn_x"}')).toThrow(/missing or non-string field/);
  });

  it('rejects invalid source enum', () => {
    const ctx = makeCtx();
    const json = JSON.parse(serializeContext(ctx)) as Record<string, unknown>;
    json.sr = 'not-a-source';
    expect(() => deserializeContext(JSON.stringify(json))).toThrow(/invalid source/);
  });

  it('rejects negative attempt', () => {
    const ctx = makeCtx();
    const json = JSON.parse(serializeContext(ctx)) as Record<string, unknown>;
    json.a = -1;
    expect(() => deserializeContext(JSON.stringify(json))).toThrow(/invalid attempt/);
  });

  it('drops non-string baggage entries defensively', () => {
    const ctx = makeCtx();
    const json = JSON.parse(serializeContext(ctx)) as Record<string, unknown>;
    json.b = { good: 'yes', bad: 42 };
    const out = deserializeContext(JSON.stringify(json));
    expect(out.baggage).toEqual({ good: 'yes' });
  });
});

describe('childSpan — v4.9.0 Slice 4', () => {
  it('keeps run/trace, forks spanId, sets parentSpanId', () => {
    const parent = makeCtx();
    const child = childSpan(parent);
    expect(child.runId).toBe(parent.runId);
    expect(child.traceId).toBe(parent.traceId);
    expect(child.daemonId).toBe(parent.daemonId);
    expect(child.spanId).not.toBe(parent.spanId);
    expect(child.parentSpanId).toBe(parent.spanId);
  });

  it('grand-child links to immediate parent (not root)', () => {
    const root = makeCtx();
    const child = childSpan(root);
    const grand = childSpan(child);
    expect(grand.parentSpanId).toBe(child.spanId);
    expect(grand.traceId).toBe(root.traceId);
  });

  it('honours the deterministic spanId override', () => {
    const parent = makeCtx();
    const fixed = newSpanId();
    const child = childSpan(parent, fixed);
    expect(child.spanId).toBe(fixed);
  });
});
