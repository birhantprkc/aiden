/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/doctorLiveness.ts — Phase v4.1.1-oauth-fix Phase 4.
 *
 * `aiden doctor --providers` deep-mode helper. Pings every configured /
 * authed provider with a minimal request, reports green / red / skipped
 * + per-provider latency + verbatim upstream error message.
 *
 * Why a separate file:
 *   - Default doctor (`aiden doctor` with no flag) stays unchanged and
 *     fast — config-shape checks only.
 *   - `--providers` is opt-in. When the user types it we extend the
 *     report with one liveness row per probe, then render a summary
 *     line at the bottom.
 *   - Tool-catalog validation is deliberately OUT of scope. Liveness
 *     probes ship `tools: []` (see comment in checkProviderLiveness)
 *     so one bad tool schema doesn't false-red every provider that
 *     validates strictly. The eval-harness / registration-time schema
 *     validator (v4.1.1 main) is the right home for that concern.
 *
 * Trust artifact:
 *   - On failure we surface `err.message` VERBATIM (truncated to 200
 *     chars). Phase 3 (`providers/v4/errors.ts`) already composes the
 *     upstream response body into ProviderError.message — so a 400
 *     prints the actual OpenAI reason, not a generic "provider failed."
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { PROVIDER_REGISTRY, type ProviderRegistryEntry } from '../../providers/v4/registry';
import { RuntimeResolver } from '../../providers/v4/runtimeResolver';
import { CredentialResolver } from '../../providers/v4/credentialResolver';
import type { ProviderAdapter, ProviderCallInput } from '../../providers/v4/types';
import {
  loadTokens,
  isExpired,
  PREFLIGHT_REFRESH_WINDOW_MS,
} from '../../core/v4/auth/tokenStore';
import type { AidenPaths } from '../../core/v4/paths';

const DEFAULT_LIVENESS_TIMEOUT_MS = 8_000;
const PROBE_MAX_TOKENS = 4;
const ERROR_TRUNCATE_CHARS = 200;
const OLLAMA_PROBE_TIMEOUT_MS = 1_500;
const OLLAMA_HEALTH_URL = 'http://127.0.0.1:11434/api/tags';

// ── Public surface ──────────────────────────────────────────────────────

export interface LivenessResult {
  /** Provider id from the registry. */
  provider: string;
  /** Model id used for the probe (undefined when skipped pre-flight). */
  model?: string;
  /** Outcome class. */
  status: 'green' | 'red' | 'skipped';
  /** Wall-clock duration of the probe. 0 for skipped. */
  latency_ms: number;
  /** Truncated upstream error message (red only). */
  error?: string;
  /** Why the provider was not probed (skipped only). */
  skip_reason?: string;
}

export interface LivenessSummary {
  green:   number;
  red:     number;
  skipped: number;
  total_ms: number;
}

export interface ConfiguredProvider {
  /** Registry entry. */
  entry:        ProviderRegistryEntry;
  /** Probe model — `entry.modelIds[0]`. */
  model:        string;
  /** True if the provider has credentials present and usable. */
  configured:   boolean;
  /** Reason a configured=false provider is being skipped. */
  reason?:      string;
}

export interface LivenessOptions {
  paths:        AidenPaths;
  env?:         NodeJS.ProcessEnv;
  fetchImpl?:   typeof fetch;
  /** Per-probe timeout. Default 8000 ms. */
  timeoutMs?:   number;
  /** Run probes concurrently. Default true. */
  parallel?:    boolean;
  /** Test-only: inject a stub resolver. Defaults to a real RuntimeResolver. */
  resolverImpl?: { resolve: (opts: any) => Promise<ProviderAdapter> };
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Truncate a long error string for display. The full error remains on
 * the in-memory `LivenessResult.error` for programmatic consumers /
 * test assertions.
 */
function truncate(s: string, max = ERROR_TRUNCATE_CHARS): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/**
 * Wrap a promise with a hard timeout. Resolves to the inner result on
 * success, throws a clearly-labelled `Error` on timeout. Cleans up the
 * timer either way.
 */
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label}: timeout after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Decide whether a provider counts as "configured" for liveness purposes.
 * Three paths:
 *   1. API key in env (`apiKeyEnvVar` set and the env var is non-empty).
 *   2. OAuth (entry.oauth present and a non-expired token sits in the
 *      tokenStore at <paths.root>/auth/<providerId>.json).
 *   3. Local providers (ollama) — probed via a quick HTTP health check.
 *
 * Anything else is `configured: false` and gets a `skip_reason`.
 */
export async function enumerateConfiguredProviders(opts: {
  paths:     AidenPaths;
  env?:      NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<ConfiguredProvider[]> {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? fetch;

  const out: ConfiguredProvider[] = [];

  for (const entry of Object.values(PROVIDER_REGISTRY)) {
    // Every provider needs at least one model to probe against.
    const model = entry.modelIds[0];
    if (!model) {
      out.push({
        entry,
        model: '',
        configured: false,
        reason: 'no models declared in registry',
      });
      continue;
    }

    // 1. API-key providers.
    if (entry.apiKeyEnvVar) {
      const value = env[entry.apiKeyEnvVar];
      if (value && value.length > 0) {
        out.push({ entry, model, configured: true });
      } else {
        out.push({
          entry,
          model,
          configured: false,
          reason: `env ${entry.apiKeyEnvVar} not set`,
        });
      }
      continue;
    }

    // 2. OAuth providers — check tokenStore.
    if (entry.oauth) {
      try {
        const tokens = await loadTokens(opts.paths, entry.oauth.providerId);
        if (tokens && tokens.accessToken) {
          if (isExpired(tokens, PREFLIGHT_REFRESH_WINDOW_MS)) {
            out.push({
              entry,
              model,
              configured: false,
              reason: 'OAuth token expired — run `/auth refresh` or `/auth login`',
            });
          } else {
            out.push({ entry, model, configured: true });
          }
        } else {
          out.push({
            entry,
            model,
            configured: false,
            reason: 'no OAuth token — run `/auth login`',
          });
        }
      } catch (err) {
        out.push({
          entry,
          model,
          configured: false,
          reason: `tokenStore read failed: ${(err as Error).message}`,
        });
      }
      continue;
    }

    // 3. Local / no-credential providers (ollama). Configured = the
    // local daemon answers a health probe.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OLLAMA_PROBE_TIMEOUT_MS);
    try {
      const res = await fetchImpl(OLLAMA_HEALTH_URL, { signal: controller.signal });
      if (res.ok) {
        out.push({ entry, model, configured: true });
      } else {
        out.push({
          entry,
          model,
          configured: false,
          reason: `local daemon HTTP ${res.status}`,
        });
      }
    } catch (err) {
      out.push({
        entry,
        model,
        configured: false,
        reason: `not running on ${OLLAMA_HEALTH_URL}`,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return out;
}

/**
 * Probe one provider/model pair via a minimal `adapter.call()`. Returns
 * a structured result; never throws.
 *
 * On failure, `result.error` is `err.message` verbatim truncated to
 * 200 chars. Phase v4.1.1-oauth-fix Phase 3 made `ProviderError.message`
 * carry the upstream response body, so a 400 surfaces the actual
 * reason (e.g. "Invalid schema for function 'subagent_fanout': …").
 */
export async function checkProviderLiveness(
  provider: string,
  model: string,
  adapter: ProviderAdapter,
  opts?: { timeoutMs?: number },
): Promise<LivenessResult> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_LIVENESS_TIMEOUT_MS;
  const start = Date.now();

  // Liveness probes "is this provider reachable + authenticated?".
  // Tool-catalog validation is a separate concern (eval harness,
  // v4.1.1 main). Sending tools: [] ensures one bad tool schema
  // doesn't false-red every provider that validates strictly.
  const input: ProviderCallInput = {
    messages:  [{ role: 'user', content: 'ping' }],
    tools:     [],
    maxTokens: PROBE_MAX_TOKENS,
  };

  try {
    await withTimeout(adapter.call(input), timeoutMs, `liveness ${provider}`);
    return {
      provider,
      model,
      status: 'green',
      latency_ms: Date.now() - start,
    };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    return {
      provider,
      model,
      status: 'red',
      latency_ms: Date.now() - start,
      error: truncate(raw),
    };
  }
}

/**
 * Run liveness probes against every provider returned by
 * `enumerateConfiguredProviders`. Unconfigured providers come back as
 * `status: 'skipped'` without any network traffic.
 *
 * Returns `{ results, summary }`. Summary tallies + a wall-clock total
 * so the UI can print "X green · Y red · Z skipped · NNNms total".
 */
export async function runProviderLiveness(opts: LivenessOptions): Promise<{
  results: LivenessResult[];
  summary: LivenessSummary;
}> {
  const start = Date.now();
  const parallel = opts.parallel ?? true;

  const resolver = opts.resolverImpl ?? new RuntimeResolver(
    new CredentialResolver(opts.paths.authJson),
  );

  const configured = await enumerateConfiguredProviders({
    paths:     opts.paths,
    env:       opts.env,
    fetchImpl: opts.fetchImpl,
  });

  const probe = async (c: ConfiguredProvider): Promise<LivenessResult> => {
    if (!c.configured) {
      return {
        provider:    c.entry.id,
        status:      'skipped',
        latency_ms:  0,
        skip_reason: c.reason ?? 'not configured',
      };
    }
    try {
      const adapter = await resolver.resolve({
        providerId: c.entry.id,
        modelId:    c.model,
        paths:      opts.paths,
      });
      return await checkProviderLiveness(
        c.entry.id,
        c.model,
        adapter,
        { timeoutMs: opts.timeoutMs },
      );
    } catch (err) {
      // Resolve failure (missing credential, unknown model, etc.).
      // Same surface treatment as a probe failure.
      const raw = err instanceof Error ? err.message : String(err);
      return {
        provider:   c.entry.id,
        model:      c.model,
        status:     'red',
        latency_ms: 0,
        error:      truncate(raw),
      };
    }
  };

  const results = parallel
    ? await Promise.all(configured.map(probe))
    : await runSequential(configured.map((c) => () => probe(c)));

  const summary: LivenessSummary = {
    green:    results.filter((r) => r.status === 'green').length,
    red:      results.filter((r) => r.status === 'red').length,
    skipped:  results.filter((r) => r.status === 'skipped').length,
    total_ms: Date.now() - start,
  };

  return { results, summary };
}

async function runSequential<T>(thunks: Array<() => Promise<T>>): Promise<T[]> {
  const out: T[] = [];
  for (const t of thunks) out.push(await t());
  return out;
}

/**
 * Render the liveness section as plain-text rows. The doctor command
 * prints this BELOW the standard health box so the default `aiden doctor`
 * output stays byte-identical.
 *
 * Visual style matches the existing doctor rows (✓ / ✗ / -) but lays
 * out as a tabular block rather than a box — the rows can be long
 * (upstream error bodies) and forcing them into the 100-col box would
 * truncate the diagnostic that's the whole point of the feature.
 */
export function renderProviderLivenessSection(
  results: LivenessResult[],
  summary: LivenessSummary,
): string {
  const nameWidth = Math.max(
    8,
    ...results.map((r) => r.provider.length),
  );

  const lines: string[] = [];
  lines.push('');
  lines.push('  Provider liveness (deep check)');
  lines.push(`  ${'─'.repeat(60)}`);

  for (const r of results) {
    const icon =
      r.status === 'green'   ? '✓'
      : r.status === 'red'   ? '✗'
      :                        '-';
    const name = r.provider.padEnd(nameWidth);
    const status =
      r.status === 'green'   ? 'green'.padEnd(8)
      : r.status === 'red'   ? 'red  '.padEnd(8)
      :                        'skip '.padEnd(8);
    const latency = r.latency_ms > 0
      ? `${r.latency_ms}ms`.padEnd(8)
      : ''.padEnd(8);
    const tail =
      r.status === 'green'   ? (r.model ?? '')
      : r.status === 'red'   ? (r.error ?? 'unknown error')
      :                        (r.skip_reason ?? 'not configured');
    lines.push(`  ${icon} ${name}  ${status}${latency}${tail}`);
  }

  lines.push(`  ${'─'.repeat(60)}`);
  lines.push(
    `  ${summary.green} green · ${summary.red} red · ${summary.skipped} skipped · ${summary.total_ms}ms total`,
  );
  lines.push('');
  return lines.join('\n');
}
