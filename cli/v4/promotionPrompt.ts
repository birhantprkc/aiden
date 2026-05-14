/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/promotionPrompt.ts — Phase v4.1.2-memory-D.
 *
 * REPL-side glue for the durable-facts promotion flow:
 *   - `parsePromotionInput(raw, count)`  — pure: parse user reply into
 *                                          a 0-indexed array of approved
 *                                          candidate indices.
 *   - `formatCandidateList(candidates)`  — pure: render the prompt body
 *                                          the user sees.
 *   - `promptForApproval(api, ...)`      — drives the prompt loop;
 *                                          re-prompts ONCE on garbage,
 *                                          then defaults to skip.
 *   - `writeApprovedDurableFacts(...)`   — append approved candidates
 *                                          to MEMORY.md `## Durable facts`
 *                                          via MemoryGuard.replaceSection.
 *
 * Input grammar (per Phase D's Q3):
 *   - "all"                  → every shown candidate
 *   - "none" / "skip" / ""   → none
 *   - "1,3"                  → 0-indexed 0 and 2
 *   - "1-3"                  → 0-indexed 0, 1, 2 (inclusive range)
 *   - "1, 3-5"               → mixed; whitespace tolerated
 *   - Anything unparseable   → re-prompt once, then default skip
 *
 * The function intentionally keeps the parser pure so unit tests
 * don't have to drive a prompt API. The prompt-loop function wires
 * the parser to the existing `ChatPromptApi.readLine`.
 */

import type { Candidate } from '../../core/v4/promotionCandidates';
import type { MemoryGuard } from '../../moat/memoryGuard';
import type { MemoryManager } from '../../core/v4/memoryManager';

// ── Parser ────────────────────────────────────────────────────────────────

/**
 * Parse a user reply into the set of approved candidate indices
 * (0-indexed). Returns `null` to signal "unparseable input — re-prompt
 * once" so callers can distinguish "explicit skip" (empty array) from
 * "garbage typed".
 *
 * Pure, deterministic; safe for unit tests.
 */
export function parsePromotionInput(
  raw:   string,
  count: number,
): number[] | null {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === '' || trimmed === 'none' || trimmed === 'skip') return [];
  if (trimmed === 'all') {
    return Array.from({ length: count }, (_, i) => i);
  }

  const out = new Set<number>();
  let sawAnyValid = false;
  // Tolerate "1, 3-5 ,7"  with mixed whitespace.
  for (const token of trimmed.split(',')) {
    const piece = token.trim();
    if (!piece) continue;
    const range = piece.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const start = Number.parseInt(range[1], 10);
      const end   = Number.parseInt(range[2], 10);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      const [lo, hi] = start <= end ? [start, end] : [end, start];
      for (let n = lo; n <= hi; n += 1) {
        if (n >= 1 && n <= count) {
          out.add(n - 1);
          sawAnyValid = true;
        }
      }
      continue;
    }
    const single = piece.match(/^\d+$/);
    if (single) {
      const n = Number.parseInt(piece, 10);
      if (n >= 1 && n <= count) {
        out.add(n - 1);
        sawAnyValid = true;
      }
      continue;
    }
    // Non-numeric token alongside others — treat the WHOLE input as
    // unparseable so the user gets one re-prompt instead of a silent
    // partial selection.
    return null;
  }
  if (!sawAnyValid) return [];                     // numbers given but all out of range
  return [...out].sort((a, b) => a - b);
}

// ── Renderer ──────────────────────────────────────────────────────────────

/**
 * Build the text the user sees. Pure — caller writes this to display.
 */
export function formatCandidateList(candidates: ReadonlyArray<Candidate>): string {
  const lines: string[] = [];
  lines.push(`${candidates.length} thing${candidates.length === 1 ? '' : 's'} worth remembering this session. Promote which?`);
  lines.push('');
  for (let i = 0; i < candidates.length; i += 1) {
    const c = candidates[i];
    const sourceTag =
      c.source === 'explicit'  ? '[user said]'
      : c.source === 'decision' ? '[decision]'
      :                            '[open item]';
    lines.push(`  [${i + 1}] ${sourceTag} ${c.text}`);
  }
  lines.push('');
  lines.push('Reply: numbers to approve (e.g. "1,3" or "1-3"), "all", or skip.');
  return lines.join('\n');
}

// ── Prompt loop ───────────────────────────────────────────────────────────

export interface PromptDisplay {
  write(s: string): void;
  dim(s: string):   void;
  warn(s: string):  void;
}

export interface PromptApi {
  readLine(prompt: string): Promise<string>;
}

/**
 * v4.1.3-essentials promotion-ux: extra knob the test harness uses to
 * force the text-input path even when stdout looks like a TTY.
 *
 *   - `forceTextInput: true`  — skip the interactive checkbox; use the
 *                                text-parser path. Used by existing
 *                                regression tests for the parser.
 *   - `forceInteractive: true` — opposite: force the interactive path
 *                                regardless of `process.stdout.isTTY`.
 *                                Used by new interactive-path tests.
 *   - neither set              — production behavior: auto-detect via
 *                                `process.stdout.isTTY`.
 */
export interface PromotionPromptOptions {
  forceTextInput?:   boolean;
  forceInteractive?: boolean;
}

/**
 * Drive the approval prompt. Two paths:
 *
 *   1. Interactive checkbox (TTY): @inquirer/prompts.checkbox, space
 *      to toggle, enter to confirm, esc/ctrl+c to skip. Default
 *      selection is NONE — the user explicitly opts in. v4.1.3-essentials
 *      promotion-ux replaces what used to be a text-input chore.
 *
 *   2. Text-input fallback (non-TTY / piped / CI): renders the
 *      numbered list and reads a single line. Parser handles "1,3"
 *      / "1-3" / "all" / "skip" / "". Re-prompts ONCE on garbage,
 *      then defaults to skip. The original Phase v4.1.2-memory-D
 *      behavior, preserved verbatim.
 *
 * Auto-routes via `process.stdout.isTTY`; tests override via opts.
 *
 * No mid-session state leakage — purely a session-end interaction.
 */
export async function promptForApproval(
  api:        PromptApi,
  display:    PromptDisplay,
  candidates: ReadonlyArray<Candidate>,
  opts:       PromotionPromptOptions = {},
): Promise<Candidate[]> {
  if (candidates.length === 0) return [];

  const useInteractive =
    opts.forceInteractive === true
      ? true
      : opts.forceTextInput === true
        ? false
        : !!process.stdout.isTTY;

  if (useInteractive) {
    return promptForApprovalInteractive(display, candidates);
  }
  return promptForApprovalText(api, display, candidates);
}

/**
 * v4.1.3-essentials promotion-ux: interactive multi-select checkbox.
 * Uses @inquirer/prompts.checkbox (already a runtime dep — same
 * library as the model picker, setup wizard, approval prompts).
 *
 * Choices render with the source-type tag inline so the user sees
 * "[decision] X" / "[open item] Y" / "[user said] Z" — matches the
 * tag set the text-input renderer uses.
 *
 * Exit paths:
 *   - User confirms with at least one box checked → return selected
 *   - User confirms with zero boxes checked       → dim note, return []
 *   - User hits Esc / Ctrl+C (inquirer throws)    → dim note, return []
 *
 * All three "nothing selected" paths produce the same outcome — empty
 * array — matching the user's Q5 default ("empty/skip/esc all
 * equivalent").
 *
 * Lazy-require inquirer so test harnesses without a TTY don't crash
 * importing the module. Same pattern setupWizard / callbacks /
 * modelPicker already use.
 */
async function promptForApprovalInteractive(
  display:    PromptDisplay,
  candidates: ReadonlyArray<Candidate>,
): Promise<Candidate[]> {
  // Dynamic ES import (not CommonJS require) so vitest's vi.mock can
  // intercept the call in tests. The runtime behavior is identical
  // for our purpose — single one-shot lazy load on first call.
  const inq = await import('@inquirer/prompts') as unknown as {
    checkbox: (opts: {
      message:  string;
      choices:  Array<{ name: string; value: number; checked?: boolean }>;
      loop?:    boolean;
      pageSize?: number;
    }) => Promise<number[]>;
  };

  const heading =
    `${candidates.length} thing${candidates.length === 1 ? '' : 's'} ` +
    `worth remembering this session.`;
  display.write('\n' + heading + '\n');

  try {
    const selected = await inq.checkbox({
      message: 'Promote which to durable memory? (space toggles · enter confirms)',
      choices: candidates.map((c, i) => ({
        name:    `${typeTag(c)} ${c.text}`,
        value:   i,
        checked: false,
      })),
      loop:    false,
      pageSize: Math.min(10, candidates.length),
    });
    if (selected.length === 0) {
      display.dim('Nothing promoted to durable facts.');
      return [];
    }
    return selected.map((i) => candidates[i]);
  } catch {
    // Inquirer throws on Ctrl+C / Esc — treat as skip.
    display.dim('Skipped: nothing promoted to durable facts.');
    return [];
  }
}

/**
 * Source-type tag matching the text-input renderer's format. Kept as
 * a helper so the interactive choice labels stay in sync with the
 * text path if a new `Candidate.source` value lands.
 */
function typeTag(c: Candidate): string {
  if (c.source === 'explicit')  return '[user said]';
  if (c.source === 'decision')  return '[decision]';
  return '[open item]';
}

/**
 * Phase v4.1.2-memory-D text-input loop. Renders the candidate list,
 * reads ONE line, parses, returns approved Candidate[]. On unparseable
 * input re-prompts ONCE; second failure defaults to skip with a dim
 * line explaining why nothing was promoted.
 *
 * Kept as the non-TTY fallback (pipes, CI, test harness) so the
 * promotion-flow contract continues to work without an interactive
 * shell. v4.1.3-essentials promotion-ux renamed this from
 * `promptForApproval` so the public entry point can dispatch.
 */
async function promptForApprovalText(
  api:        PromptApi,
  display:    PromptDisplay,
  candidates: ReadonlyArray<Candidate>,
): Promise<Candidate[]> {
  display.write('\n' + formatCandidateList(candidates) + '\n');

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const raw = await api.readLine('Promote > ');
    const parsed = parsePromotionInput(raw, candidates.length);
    if (parsed !== null) {
      if (parsed.length === 0) {
        display.dim('Nothing promoted to durable facts.');
        return [];
      }
      return parsed.map((i) => candidates[i]);
    }
    if (attempt === 0) {
      display.warn('Could not parse input. Use numbers ("1,3"), ranges ("1-3"), "all", or "skip".');
    }
  }

  display.dim('Skipped: input still unparseable. Nothing promoted to durable facts.');
  return [];
}

// ── Persistence ───────────────────────────────────────────────────────────

const DURABLE_FACTS_HEADER = '## Durable facts';

/**
 * Render the section body for `## Durable facts` by combining existing
 * entries with newly-approved candidates. Newest at the BOTTOM so
 * read order reflects when each fact landed — matches how users scan
 * MEMORY.md.
 *
 * Pure — caller passes existing body (extracted via the same regex
 * pattern MemoryGuard uses in replaceSection).
 */
export function buildDurableFactsBody(
  existingBody: string,
  approved:     ReadonlyArray<Candidate>,
): string {
  const existingLines = existingBody
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const newLines = approved.map((c) => `- ${c.text}`);
  return [...existingLines, ...newLines].join('\n');
}

/**
 * Read the current `## Durable facts` body from MEMORY.md (returns
 * empty string when the section doesn't yet exist). Mirrors the
 * regex pattern MemoryGuard.replaceSection uses.
 */
export async function readExistingDurableFactsBody(
  memoryManager: MemoryManager,
): Promise<string> {
  const snap = await memoryManager.loadSnapshot();
  const md = snap.memoryMd ?? '';
  const headerEscaped = DURABLE_FACTS_HEADER.replace(
    /[.*+?^${}()|[\]\\]/g,
    '\\$&',
  );
  const sectionRe = new RegExp(
    `${headerEscaped}[^\\n]*\\n([\\s\\S]*?)(?=\\n## |$)`,
  );
  const m = md.match(sectionRe);
  return m ? (m[1] ?? '').trim() : '';
}

/**
 * Persist the approved candidates. Reads existing body (so a second
 * session-end appends rather than overwrites), folds in new lines,
 * and writes via MemoryGuard.replaceSection — which handles
 * verify-on-disk + section auto-creation.
 *
 * Returns the GuardedResult so the caller can dim-log success or
 * warn on a failed verify.
 */
export async function writeApprovedDurableFacts(
  memoryManager: MemoryManager,
  memoryGuard:   MemoryGuard,
  approved:      ReadonlyArray<Candidate>,
): Promise<{ ok: boolean; verified: boolean; reason?: string; entryCount: number }> {
  if (approved.length === 0) {
    return { ok: true, verified: true, entryCount: 0 };
  }
  const existingBody = await readExistingDurableFactsBody(memoryManager);
  const newBody = buildDurableFactsBody(existingBody, approved);
  const entryCount = newBody.split('\n').filter((l) => l.trim().length > 0).length;
  const result = await memoryGuard.replaceSection('memory', DURABLE_FACTS_HEADER, newBody);
  return {
    ok:       result.ok,
    verified: result.verified,
    reason:   result.reason,
    entryCount,
  };
}
