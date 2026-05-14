/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/sessionDistiller.ts — Phase v4.1.2-memory-AB.
 *
 * Replaces the lossy 5-bullet auxiliary summary with a structured
 * SessionDistillation:
 *
 *   - bullets[]       (5 bullets, back-compat with MEMORY.md `## Recent sessions`)
 *   - decisions[]     (higher-fidelity than bullets)
 *   - open_items[]    (unfinished work, useful for next session)
 *   - keywords[]      (for future retrieval ranking — Phase C)
 *   - files_touched[] (DETERMINISTIC — derived from tool-call result payloads)
 *   - tools_used[]    (DETERMINISTIC — counted from tool-call trace names)
 *   - schema_version  (always 1; reserved for future migrations)
 *   - exit_path       (which exit caused the distillation: quit/sigint/etc.)
 *   - partial         (set true when LLM JSON parse falls back to bullets-only)
 *
 * Source-of-truth split:
 *   - Programmatic fields (files_touched, tools_used) → trace inspection.
 *   - Semantic fields (bullets, decisions, open_items, keywords) → single
 *     auxiliary-LLM call with strict-then-lenient JSON parsing.
 *
 * Phase A's CLI ChatSession owns the per-session HonestyTraceEntry[]
 * accumulator and passes it here. The auxiliary call sees the full
 * message history (not the trace — the trace is purely for programmatic
 * field derivation).
 */

import type { Message } from '../../providers/v4/types';
import type { AuxiliaryClient } from './auxiliaryClient';
import type { HonestyTraceEntry } from '../../moat/honestyEnforcement';

// ── Public surface ───────────────────────────────────────────────────────

export const SESSION_DISTILLATION_SCHEMA_VERSION = 1;

/** Which exit class fired the distillation. */
export type SessionExitPath =
  | 'quit'      // explicit /quit, /exit, /q slash commands
  | 'sigint'    // Ctrl-C
  | 'sigterm'   // OS termination
  | 'eof'       // stdin close / EOF (Ctrl-D on POSIX)
  | 'crash';    // unhandled exception

export interface SessionDistillation {
  /** Bumped when the on-disk JSON shape changes incompatibly. */
  schema_version: typeof SESSION_DISTILLATION_SCHEMA_VERSION;
  session_id:     string;
  started_at:     string;                  // ISO
  ended_at:       string;                  // ISO
  exit_path:      SessionExitPath;
  user_turns:     number;

  // Semantic fields — auxiliary-LLM-generated.
  bullets:        string[];
  decisions:      string[];
  open_items:     string[];
  keywords:       string[];

  // Deterministic fields — derived from the accumulated tool trace.
  files_touched:  string[];
  tools_used:     Array<{ name: string; count: number }>;

  /**
   * True when the auxiliary LLM's JSON output was unparseable and we
   * fell back to bullets-only. Absent on full distillations. Future
   * retrieval (Phase C) treats partial entries as second-class.
   */
  partial?:       true;
}

// ── Programmatic field derivation ─────────────────────────────────────────

/**
 * Tools whose result payload SHOULD contain a `path` field naming the
 * file they touched. Used to populate `files_touched`.
 *
 * Curated rather than "any tool with a path in its result" because
 * read-only tools (`file_read`, `file_list`) shouldn't count as
 * "touched" — only mutating ops do.
 */
const FILE_TOUCH_TOOLS = new Set<string>([
  'file_write',
  'file_patch',
  'file_create',
  'file_delete',
  'memory_add',         // writes MEMORY.md / USER.md
  'memory_remove',
  'memory_replace',
  'session_summary',    // writes MEMORY.md
]);

/**
 * Extract programmatic fields from the accumulated tool trace. Pure
 * function — no I/O.
 */
export function deriveProgrammaticFields(
  trace: ReadonlyArray<HonestyTraceEntry>,
): Pick<SessionDistillation, 'files_touched' | 'tools_used'> {
  // tools_used: count by name, sorted by count desc, name asc.
  const counts = new Map<string, number>();
  for (const e of trace) {
    counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
  }
  const tools_used = Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) =>
      b.count - a.count || a.name.localeCompare(b.name),
    );

  // files_touched: unique paths from mutating tool results.
  // Each entry's `result` may be { success, path, ... } or { path: ... }
  // depending on the tool. We accept either shape.
  const paths = new Set<string>();
  for (const e of trace) {
    if (e.error) continue;                // failed tool — don't credit
    if (!FILE_TOUCH_TOOLS.has(e.name))    continue;
    const candidate = extractPath(e.result);
    if (candidate) paths.add(candidate);
  }
  const files_touched = Array.from(paths).sort();

  return { files_touched, tools_used };
}

function extractPath(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  // Top-level path field — most write tools.
  const top = (result as { path?: unknown }).path;
  if (typeof top === 'string' && top.length > 0) return top;
  // Nested under .result (some adapters wrap output).
  const inner = (result as { result?: unknown }).result;
  if (inner && typeof inner === 'object') {
    const innerPath = (inner as { path?: unknown }).path;
    if (typeof innerPath === 'string' && innerPath.length > 0) return innerPath;
  }
  return null;
}

// ── LLM extraction ────────────────────────────────────────────────────────

/**
 * Strict-then-lenient parser for the auxiliary LLM's distillation JSON.
 *
 * Strict path: parse as JSON, validate shape, return all four semantic
 * fields. Lenient path (only when strict fails): try to extract a
 * bullets array from a malformed body (codepath shared with slice2's
 * parseSessionBulletsResponse fallback), set the other three fields to
 * empty arrays, and signal `partial: true` to the caller.
 *
 * Pure function — no I/O. Caller decides what to do with `partial`.
 */
export function parseLLMDistillation(
  raw: string,
): {
  bullets:    string[];
  decisions:  string[];
  open_items: string[];
  keywords:   string[];
  partial:    boolean;
} {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { bullets: [], decisions: [], open_items: [], keywords: [], partial: true };
  }
  // Strict path.
  const strict = tryStrictParse(trimmed);
  if (strict) return { ...strict, partial: false };

  // Lenient: scan for a JSON object embedded in prose (some models
  // prefix "Here is the JSON:\n{...}"). Trim to the first '{' through
  // the last '}' and retry.
  const first = trimmed.indexOf('{');
  const last  = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const inner = trimmed.slice(first, last + 1);
    const second = tryStrictParse(inner);
    if (second) return { ...second, partial: false };
  }

  // Bullets-only fallback — recover what we can. Tries a bare bullet
  // list ("- ...", "* ...", numbered lines) or a JSON-array fragment.
  const fallbackBullets = recoverBullets(trimmed);
  return {
    bullets:    fallbackBullets,
    decisions:  [],
    open_items: [],
    keywords:   [],
    partial:    true,
  };
}

function tryStrictParse(s: string): {
  bullets:    string[];
  decisions:  string[];
  open_items: string[];
  keywords:   string[];
} | null {
  try {
    const obj = JSON.parse(s) as unknown;
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const o = obj as Record<string, unknown>;
    const bullets    = toStringArray(o.bullets);
    const decisions  = toStringArray(o.decisions);
    const open_items = toStringArray(o.open_items ?? o.openItems);
    const keywords   = toStringArray(o.keywords);
    if (bullets.length === 0 && decisions.length === 0 && open_items.length === 0) {
      return null;     // nothing useful — let the lenient path try
    }
    return { bullets, decisions, open_items, keywords };
  } catch {
    return null;
  }
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

function recoverBullets(raw: string): string[] {
  // Strategy 1: bullet-prefixed lines.
  const lines = raw.split(/\r?\n/);
  const bulleted = lines
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+\.)\s+/, '').trim())
    .filter((l, i, arr) => l.length > 0 && /^\s*(?:[-*•]|\d+\.)\s+/.test(lines[i] ?? ''));
  if (bulleted.length > 0) return bulleted.slice(0, 5);

  // Strategy 2: a JSON array of strings, with or without the object wrapper.
  const arrMatch = raw.match(/\[\s*"[\s\S]*?"\s*\]/);
  if (arrMatch) {
    try {
      const arr = JSON.parse(arrMatch[0]) as unknown;
      return toStringArray(arr).slice(0, 5);
    } catch { /* fall through */ }
  }
  return [];
}

// ── Orchestrator ──────────────────────────────────────────────────────────

export interface DistillSessionOptions {
  sessionId:       string;
  startedAt:       string;
  endedAt?:        string;                  // defaults to now()
  exitPath:        SessionExitPath;
  userTurns:       number;
  /** Full conversation history — passed to the auxiliary LLM. */
  messages:        ReadonlyArray<Message>;
  /** Accumulated tool trace across all turns this session. */
  toolTrace:       ReadonlyArray<HonestyTraceEntry>;
  auxiliaryClient: AuxiliaryClient;
  /** Wall-clock cap on the auxiliary LLM call. Default 12000 ms
   *  (raised from 4000 ms in v4.1.3-essentials — see DEFAULT_TIMEOUT_MS). */
  timeoutMs?:      number;
  /**
   * v4.1.3-essentials distillation-fix: optional diagnostic sink.
   * Receives a single-string explanation when the distillation falls
   * back to `partial:true`. Three classes:
   *
   *   - "auxiliary call timed out after <ms>ms"
   *   - "auxiliary call failed: <message>"
   *   - "auxiliary returned unparseable JSON (first 200 chars: ...)"
   *
   * Caller routes this to `display.dim()` (or stderr in CLI contexts)
   * so the user can see WHY their session produced no semantic
   * fields. Before this hook the failure was completely silent —
   * the only visible artifact was the downstream "no bullets" warning
   * which didn't distinguish among the three causes.
   *
   * Callback runs synchronously inside `distillSession`; errors thrown
   * from it bubble out, so consumers should be defensive (the
   * built-in caller wraps it in try/catch).
   */
  onDiagnostic?:   (message: string) => void;
}

/**
 * v4.1.3-essentials distillation-fix: default raised from 4000ms to
 * 12000ms after visual smoke showed chatgpt-plus Codex regularly
 * exceeded the original budget for 800-token summaries on
 * cold-start. Symptom: every `/quit` distillation returned
 * `partial:true` with empty bullets/decisions/open_items, killing
 * both the MEMORY.md update path AND the promotion prompt.
 *
 * 12s gives comfortable headroom while still aborting genuinely
 * stuck calls. Power users can override via `AIDEN_SUMMARY_TIMEOUT_MS`
 * env var (consumed by `resolveSummaryTimeoutMs()` in chatSession).
 */
const DEFAULT_TIMEOUT_MS = 12_000;

/**
 * Phase v4.1.2-bug-Y: max chars of tool-result content surfaced to the
 * auxiliary LLM. Covers typical error messages + JSON-payload heads
 * without bloating the prompt with full tool-output dumps. User and
 * assistant TEXT are never truncated — user intent must survive in
 * full. Widen this only after eval shows truncation eating signal.
 */
export const TOOL_RESULT_TRUNCATION = 200;

/**
 * Pure: filter + format the conversation history into the transcript
 * the auxiliary LLM sees. Phase v4.1.2-bug-Y root-cause fix:
 *
 *   The previous distiller dumped chatSession.history verbatim,
 *   including the giant `role: 'system'` block PromptBuilder
 *   constructs (SOUL.md identity, MEMORY.md, USER.md, Runtime slot,
 *   Capabilities boilerplate, tool-catalog descriptions, personality
 *   overlay, execution-discipline notes). Weak summarizer models
 *   latched onto this longest-coherent-block in context as the
 *   session topic, returning bullets like "I'm Aiden, a local-first
 *   AI agent built by Taracod" regardless of what the user and
 *   assistant actually discussed.
 *
 *   This filter drops ALL `role: 'system'` messages and emits the
 *   remaining traffic as role-tagged lines:
 *
 *     [USER] full user message verbatim
 *     [ASSISTANT] assistant text (if non-empty)
 *     [TOOL:name] {args}
 *     [TOOL:name] → result-payload, truncated to TOOL_RESULT_TRUNCATION
 *
 *   Tool results carry their tool name (resolved via toolCallId →
 *   call-name map walked through preceding assistant turns) so the
 *   model can correlate tool intent with output. Empty messages are
 *   dropped entirely. Multi-line content within a message is
 *   preserved.
 */
export function filterMessagesForDistillation(
  messages: ReadonlyArray<Message>,
): string {
  /** Per-toolCallId → toolName, populated as we walk assistant turns. */
  const callNames = new Map<string, string>();
  const lines: string[] = [];

  for (const m of messages) {
    if (m.role === 'system') continue;       // entire boilerplate source — dropped

    if (m.role === 'user') {
      const text = m.content.trim();
      if (text.length === 0) continue;
      lines.push(`[USER] ${text}`);
      continue;
    }

    if (m.role === 'assistant') {
      // Emit assistant text only if non-empty — avoid empty `[ASSISTANT]`
      // placeholder for tool-only turns.
      const text = (m.content ?? '').trim();
      if (text.length > 0) lines.push(`[ASSISTANT] ${text}`);
      // Tool calls: cache the id → name pair so the matching tool
      // result downstream can render with its tool name. Emit the
      // call line in original order.
      if (m.toolCalls && m.toolCalls.length > 0) {
        for (const tc of m.toolCalls) {
          callNames.set(tc.id, tc.name);
          const argsStr = compactArgs(tc.arguments);
          lines.push(`[TOOL:${tc.name}] ${argsStr}`);
        }
      }
      continue;
    }

    if (m.role === 'tool') {
      const name = callNames.get(m.toolCallId) ?? 'unknown';
      const truncated = truncateForTranscript(m.content);
      lines.push(`[TOOL:${name}] → ${truncated}`);
      continue;
    }
  }

  return lines.join('\n');
}

/**
 * Compact tool-call args into a one-line representation. JSON shape
 * preserved; large strings get truncated alongside everything else
 * to keep the transcript focused on intent, not full payloads.
 */
function compactArgs(args: Record<string, unknown> | undefined): string {
  if (!args || Object.keys(args).length === 0) return '{}';
  try {
    return truncateForTranscript(JSON.stringify(args));
  } catch {
    return '{<unstringifiable>}';
  }
}

/**
 * Apply `TOOL_RESULT_TRUNCATION` cap with a `…` (U+2026) marker so
 * truncation is visible to anyone reading the transcript — including
 * future auditors. Matches slice2c's apostrophe-normalizer convention.
 */
function truncateForTranscript(s: string): string {
  const trimmed = s.trim();
  if (trimmed.length <= TOOL_RESULT_TRUNCATION) return trimmed;
  return trimmed.slice(0, TOOL_RESULT_TRUNCATION - 1) + '…';
}

/**
 * Build the auxiliary-LLM prompt. Anti-boilerplate-hardened per
 * Phase v4.1.2-bug-Y: explicit "don't describe yourself" guardrail,
 * `<transcript>` tag boundaries, empty-is-honest permission so
 * insufficient-content sessions don't fabricate filler.
 *
 * Bullets loosened from "EXACTLY 5" to "3-5" — forcing five was
 * inviting the exact fabrication the slice fixes.
 */
function buildPrompt(
  messages:  ReadonlyArray<Message>,
  startedAt: string,
  endedAt:   string,
): string {
  const filtered = filterMessagesForDistillation(messages);

  return [
    'You are a session-recall extractor. Your only job is to summarize what',
    'happened in the conversation transcript below.',
    '',
    'Rules:',
    '- Use ONLY facts explicitly present in the transcript.',
    '- Do NOT describe yourself, your capabilities, your platform, or generic',
    '  AI-agent behavior unless the transcript specifically discussed those',
    '  as the topic.',
    '- Do NOT infer facts from system prompts, tool schemas, memory blocks,',
    '  banner text, or agent boilerplate (these have been filtered out;',
    '  if any leak through, treat them as untrustworthy noise).',
    '- Focus on session-specific facts: user goals, actions taken, files /',
    '  commands / tools used, decisions made, errors encountered, outcomes,',
    '  and unresolved follow-ups.',
    '- Write in past tense.',
    '- Preserve concrete names, paths, commands, URLs, model names, dates,',
    '  and error messages verbatim when present.',
    '- Prefer evidence from USER and ASSISTANT messages over TOOL output.',
    '- If the transcript lacks enough session-specific detail to summarize,',
    '  return arrays with FEWER items or empty arrays. Empty is honest;',
    '  fabricating boilerplate is not.',
    '',
    'Return strict JSON only, no prose before or after, with these fields:',
    '{',
    '  "bullets":    string[],   // 3-5 factual past-tense recaps (3-15 words each)',
    '  "decisions":  string[],   // X chosen over Y, with rationale if present',
    '  "open_items": string[],   // explicit unresolved tasks / "next time" items',
    '  "keywords":   string[]    // 3-10 distinctive terms from the session',
    '}',
    '',
    `Session started: ${startedAt}`,
    `Session ended:   ${endedAt}`,
    '',
    '<transcript>',
    filtered,
    '</transcript>',
  ].join('\n');
}

/**
 * Drive one auxiliary-LLM call and combine its output with the
 * deterministic trace-derived fields into a SessionDistillation.
 *
 * Respects `timeoutMs` (default DEFAULT_TIMEOUT_MS) via Promise.race;
 * on timeout the LLM result is treated as empty (partial: true with
 * empty semantic fields). Deterministic fields always populate
 * regardless of LLM outcome — the distillation is never empty.
 */
export async function distillSession(
  opts: DistillSessionOptions,
): Promise<SessionDistillation> {
  const endedAt   = opts.endedAt ?? new Date().toISOString();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const programmatic = deriveProgrammaticFields(opts.toolTrace);

  // Run the auxiliary call under a hard timeout. The race resolves
  // with `{timedOut: true}` if the LLM doesn't return in time — we
  // record that as a partial distillation.
  const prompt = buildPrompt(opts.messages, opts.startedAt, endedAt);
  const llmRaw = await Promise.race([
    opts.auxiliaryClient
      .call({ purpose: 'session_summary', prompt, maxTokens: 800 })
      .then((r) => ({ ok: true as const, content: r.content ?? '' }))
      .catch((e) => ({ ok: false as const, error: e as Error })),
    new Promise<{ ok: false; error: Error; timedOut: true }>((resolve) => {
      setTimeout(
        () => resolve({ ok: false, error: new Error(`auxiliary call timed out after ${timeoutMs}ms`), timedOut: true }),
        timeoutMs,
      );
    }),
  ]);

  // v4.1.3-essentials distillation-fix: emit a diagnostic line for
  // each of the three failure classes so the caller can surface the
  // root cause. Previously all three paths produced an identical
  // `partial:true + empty` result with no signal about WHICH failure
  // fired. Safe to call onDiagnostic synchronously — caller wraps in
  // try/catch so a throwing sink doesn't break distillation.
  const diag = (msg: string): void => {
    if (!opts.onDiagnostic) return;
    try { opts.onDiagnostic(msg); } catch { /* never break distillation */ }
  };

  let semantic: ReturnType<typeof parseLLMDistillation>;
  if (llmRaw.ok) {
    semantic = parseLLMDistillation(llmRaw.content);
    if (semantic.partial) {
      // Parser fell back to bullets-only or fully-empty — the LLM
      // returned content but it wasn't valid JSON. First-200-chars
      // hint lets the user / debugger see what shape the model
      // actually emitted (often a chatty preamble that confused
      // the JSON extractor).
      const head = llmRaw.content.trim().slice(0, 200).replace(/\n/g, ' ');
      diag(`auxiliary returned unparseable JSON (first 200 chars: ${head})`);
    }
  } else {
    // Race resolved with the failure branch — either the timeout
    // fired or auxiliaryClient.call threw. Hoist `error` into a
    // local so the narrowed type stays stable inside the branch
    // (TS can't infer `error` exists on `llmRaw` because the union
    // overlaps with the success branch in its type literal).
    const failure = llmRaw as { error: Error; timedOut?: boolean };
    if (failure.timedOut === true) {
      diag(`auxiliary call timed out after ${timeoutMs}ms`);
    } else {
      diag(`auxiliary call failed: ${failure.error.message}`);
    }
    semantic = {
      bullets:    [],
      decisions:  [],
      open_items: [],
      keywords:   [],
      partial:    true,
    };
  }

  const dist: SessionDistillation = {
    schema_version: SESSION_DISTILLATION_SCHEMA_VERSION,
    session_id:     opts.sessionId,
    started_at:     opts.startedAt,
    ended_at:       endedAt,
    exit_path:      opts.exitPath,
    user_turns:     opts.userTurns,
    bullets:        semantic.bullets,
    decisions:      semantic.decisions,
    open_items:     semantic.open_items,
    keywords:       semantic.keywords,
    files_touched:  programmatic.files_touched,
    tools_used:     programmatic.tools_used,
  };
  if (semantic.partial) dist.partial = true;
  return dist;
}
