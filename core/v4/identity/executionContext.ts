/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/identity/executionContext.ts — v4.9.0 Slice 4.
 *
 * The `ExecutionContext` is the per-unit-of-work envelope every layer
 * of the runtime can reach via `currentContext()`. It carries the
 * stable correlation IDs (daemon, incarnation, run, trace, span) plus
 * the situational metadata (source, attempt, deadline, optional
 * external request id, optional baggage).
 *
 * Slice 4 is **additive only** — nothing in the existing code paths
 * required a context yet; this file just defines the shape and the
 * (de)serialisation primitives so later slices can plumb it through
 * tool dispatch, hooks, trigger bus claims, and the agent loop.
 *
 * Serialisation is JSON. We could compact this further (e.g. msgpack
 * over a base64url envelope) but JSON keeps it grep-friendly in env
 * vars and log lines — and the contexts we'll be ferrying are <300 bytes.
 */
import { newSpanId } from './ids';

export type ExecutionSource =
  | 'cli'
  | 'api'
  | 'webhook'
  | 'cron'
  | 'email'
  | 'folder'
  | 'subagent'
  | 'unknown';

export interface ExecutionContext {
  /** Persistent daemon identity (`dmn_...`). */
  daemonId:           string;
  /** This daemon process (`inc_...`). */
  incarnationId:      string;
  /** The unit of work (`run_...`). */
  runId:              string;
  /** Top-level correlation across runs/spans (`trc_...`). */
  traceId:            string;
  /** Sub-unit of a trace (`spn_...`). */
  spanId:             string;
  /** Parent span when this is a child; root span omits this field. */
  parentSpanId?:      string;
  /** Internal request id (e.g. our own webhook handler request). */
  requestId?:         string;
  /** External request id (e.g. `X-Request-ID` header from caller). */
  externalRequestId?: string;
  /** Trigger that spawned this work (`trg_...`). */
  triggerId?:         string;
  /** Session this work belongs to (CLI session id). */
  sessionId?:         string;
  /** How this work was kicked off. */
  source:             ExecutionSource;
  /** Retry counter — 0 = first attempt. */
  attempt:            number;
  /** RFC 3339 timestamp; when set, callers should refuse work past it. */
  deadlineAt?:        string;
  /** Free-form key/value bag. W3C `tracestate`-style — small + opaque. */
  baggage?:           Record<string, string>;
}

const VALID_SOURCES: ReadonlySet<string> = new Set<ExecutionSource>([
  'cli', 'api', 'webhook', 'cron', 'email', 'folder', 'subagent', 'unknown',
]);

/**
 * Serialise a context to a single string suitable for stuffing into an
 * env var, a log field, or a tracestate-style header. Round-trippable
 * via `deserializeContext`.
 *
 * We don't ship undefined fields — keeps the payload tight when most
 * of the optional surface is empty (the common case).
 */
export function serializeContext(ctx: ExecutionContext): string {
  const payload: Record<string, unknown> = {
    d:  ctx.daemonId,
    i:  ctx.incarnationId,
    r:  ctx.runId,
    t:  ctx.traceId,
    s:  ctx.spanId,
    sr: ctx.source,
    a:  ctx.attempt,
  };
  if (ctx.parentSpanId)      payload.ps = ctx.parentSpanId;
  if (ctx.requestId)         payload.rq = ctx.requestId;
  if (ctx.externalRequestId) payload.er = ctx.externalRequestId;
  if (ctx.triggerId)         payload.tg = ctx.triggerId;
  if (ctx.sessionId)         payload.se = ctx.sessionId;
  if (ctx.deadlineAt)        payload.dl = ctx.deadlineAt;
  if (ctx.baggage && Object.keys(ctx.baggage).length > 0) payload.b = ctx.baggage;
  return JSON.stringify(payload);
}

/**
 * Parse a serialised context. Throws on malformed input — this is a
 * trust-boundary deserialise (env var that's supposed to exist), so
 * "fail loud" beats silent context loss.
 */
export function deserializeContext(s: string): ExecutionContext {
  if (typeof s !== 'string' || s.length === 0) {
    throw new Error('deserializeContext: input must be a non-empty string');
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(s) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`deserializeContext: invalid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  const need = (k: string): string => {
    const v = raw[k];
    if (typeof v !== 'string' || v.length === 0) {
      throw new Error(`deserializeContext: missing or non-string field '${k}'`);
    }
    return v;
  };
  // Validate required string fields FIRST so a malformed payload gets
  // a useful "missing field 'X'" message rather than a downstream
  // "invalid source 'undefined'" surprise.
  const daemonId      = need('d');
  const incarnationId = need('i');
  const runId         = need('r');
  const traceId       = need('t');
  const spanId        = need('s');
  const source = need('sr');
  if (!VALID_SOURCES.has(source)) {
    throw new Error(`deserializeContext: invalid source '${source}'`);
  }
  const attempt = Number(raw.a);
  if (!Number.isFinite(attempt) || attempt < 0) {
    throw new Error(`deserializeContext: invalid attempt '${String(raw.a)}'`);
  }
  const ctx: ExecutionContext = {
    daemonId,
    incarnationId,
    runId,
    traceId,
    spanId,
    source:        source as ExecutionSource,
    attempt,
  };
  if (typeof raw.ps === 'string') ctx.parentSpanId      = raw.ps;
  if (typeof raw.rq === 'string') ctx.requestId         = raw.rq;
  if (typeof raw.er === 'string') ctx.externalRequestId = raw.er;
  if (typeof raw.tg === 'string') ctx.triggerId         = raw.tg;
  if (typeof raw.se === 'string') ctx.sessionId         = raw.se;
  if (typeof raw.dl === 'string') ctx.deadlineAt        = raw.dl;
  if (raw.b && typeof raw.b === 'object' && !Array.isArray(raw.b)) {
    // Defensive cast: only string-valued entries survive.
    const bag: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.b as Record<string, unknown>)) {
      if (typeof v === 'string') bag[k] = v;
    }
    if (Object.keys(bag).length > 0) ctx.baggage = bag;
  }
  return ctx;
}

/**
 * Fork a child span: returns a new context with the same trace/run but
 * a fresh `spanId` and `parentSpanId` set to the parent's `spanId`.
 *
 * Pass `newSpanIdOverride` only in tests where determinism matters; in
 * normal operation the freshly-minted span id is what you want.
 */
export function childSpan(
  ctx: ExecutionContext,
  newSpanIdOverride?: string,
): ExecutionContext {
  return {
    ...ctx,
    spanId:       newSpanIdOverride ?? newSpanId(),
    parentSpanId: ctx.spanId,
  };
}
