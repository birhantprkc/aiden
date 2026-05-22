/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/identity/contextManager.ts — v4.9.0 Slice 4.
 *
 * Thin wrapper over `node:async_hooks`' `AsyncLocalStorage` exposing
 * three primitives:
 *
 *   - `runWithContext(ctx, fn)` — entry point; installs the context
 *     for the duration of `fn` (and every awaited continuation it
 *     spawns). Returns whatever `fn` returns. Synchronous closures
 *     and async functions both work.
 *
 *   - `currentContext()` — returns the ambient context or `undefined`
 *     when called outside any `runWithContext` frame. Cheap; safe to
 *     call from anywhere (logger sinks, tool handlers, hooks).
 *
 *   - `requireContext(kind?)` — same as `currentContext()` but throws
 *     when no context is active. Use this at boundaries that should
 *     never run un-contexted (e.g. inside a tool handler that depends
 *     on the runId for idempotency). The optional `kind` hint goes
 *     into the error message for easier debugging.
 *
 * Slice 4 only INSTALLS the storage + primitives. It does NOT wrap
 * existing call sites — that's later-slice work. The logger picks up
 * `currentContext()` automatically; if you don't enter a
 * `runWithContext` frame, you get the pre-Slice-4 log shape exactly.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { ExecutionContext } from './executionContext';

const als = new AsyncLocalStorage<ExecutionContext>();

/**
 * Install `ctx` as the ambient context for the synchronous and async
 * lifetime of `fn`. Any code reached via `await` within `fn` (or via
 * timer callbacks scheduled from inside `fn`) sees the same context.
 *
 * The store unwinds when `fn` completes (or throws). Use a sibling
 * `runWithContext` call to switch contexts; `als.enterWith(...)` is
 * deliberately NOT exposed — it leaks across boundaries and we want
 * the scoping discipline.
 */
export function runWithContext<T>(ctx: ExecutionContext, fn: () => T): T {
  return als.run(ctx, fn);
}

/**
 * Read the ambient context. Returns `undefined` outside a
 * `runWithContext` frame.
 *
 * Never throws — by the project rule "no log formatter throws because
 * context is missing", callers in the logging path consume the
 * undefined and degrade gracefully.
 */
export function currentContext(): ExecutionContext | undefined {
  return als.getStore();
}

/**
 * Read the ambient context, throwing when none is active. Use this in
 * code paths that depend on having an id (e.g. tool dispatch for
 * idempotency, hook firing). The `kind` argument is purely diagnostic;
 * it shows up in the error message so you can tell which call site
 * was un-contexted.
 *
 * Slice 4 does NOT add `requireContext()` to any existing call site;
 * the function is here for future slices to opt in. The additive-only
 * constraint is intentional — Slice 4 must not break existing call
 * sites that have no ambient context.
 */
export function requireContext(kind?: string): ExecutionContext {
  const ctx = als.getStore();
  if (!ctx) {
    const where = kind ? ` (required by: ${kind})` : '';
    throw new Error(`requireContext: no ambient ExecutionContext${where}`);
  }
  return ctx;
}
