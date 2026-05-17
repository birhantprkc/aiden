/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/suggestionEngine.ts — v4.5 Phase 8b.
 *
 * Contextual one-time suggestions for the v4.4/v4.5 subsystems the
 * user hasn't enabled yet. Fires when their CURRENT task would
 * genuinely benefit:
 *
 *   - sandbox            → destructive shell pattern + sandbox is OFF
 *   - browser_depth      → browser_* tool call + browser_depth is OFF
 *   - daemon_scheduling  → user said "every day", "watch this folder",
 *                          "when an email arrives", etc.
 *   - tce_recovery       → recovery situation reached + TCE is OFF
 *                          (lower priority; most users keep TCE on)
 *
 * Budget Q-P8b-1(a): 2 suggestions per session global. Each slot
 * fires AT MOST ONCE per session. Resets on REPL restart.
 *
 * Dismissal Q-P8b-4(c) + Q-P8b-6(a):
 *   - Per-session: `dismissAll()` silences for the rest of the session.
 *   - Permanent: `runtime_toggles.suggestions = false` in config.yaml
 *     (slash command persists). Engine reads via runtimeToggles
 *     singleton — when the toggle reports OFF the engine treats every
 *     classification as "no tip".
 *
 * Pure module — no I/O. Display happens at the call site
 * (`display.dim()` per audit Q-P8b-3). Engine only classifies +
 * tracks state.
 */

import { classifyCommand } from '../../moat/dangerousPatterns';
import { getRuntimeToggles } from './runtimeToggles';
import { suggestionMessageFor } from './suggestionCatalog';

// ── Public types ───────────────────────────────────────────────────────────

export type SuggestionSlot =
  | 'sandbox'
  | 'browser_depth'
  | 'daemon_scheduling'
  | 'tce_recovery';

export interface Suggestion {
  slot:    SuggestionSlot;
  message: string;
}

export interface SuggestionEngine {
  /**
   * Pre-tool-call check. Returns a suggestion when the call's
   * classified slot is OFF + the slot hasn't fired this session +
   * the global budget isn't exhausted. Returns null otherwise.
   *
   * Caller renders via `display.dim(suggestion.message)` and then
   * calls `recordFired(suggestion.slot)` to update state. (The
   * engine doesn't auto-record because the caller decides whether
   * the suggestion was actually surfaced — display may be muted.)
   */
  checkToolCall(call: { name: string; arguments?: unknown }): Suggestion | null;
  /**
   * Initial-message check. Classifies daemon-scheduling intent
   * from the user's first message of the turn. Fires once per
   * session at most.
   */
  checkInitialMessage(message: string): Suggestion | null;
  /** Mark a slot as just-suggested so subsequent calls skip it. */
  recordFired(slot: SuggestionSlot): void;
  /** Per-session opt-out — silences every slot for the rest of the session. */
  dismissAll(): void;
  /** Snapshot for `/suggestions status`. */
  snapshot(): {
    firedSlots:       SuggestionSlot[];
    dismissedSession: boolean;
    permanentlyOff:   boolean;
    budgetRemaining:  number;
  };
  /** Test-only reset. */
  _resetForTests(): void;
}

// ── Daemon-scheduling regex (Q-P8b-2a — simple keyword) ────────────────────

const SCHEDULING_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(every|each)\s+(day|hour|minute|week|morning|evening|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  /\b(daily|hourly|weekly|nightly)\b/i,
  /\bat\s+\d{1,2}(:\d{2})?\s*(am|pm)?\s+(every|each)\b/i,
  /\bwatch\s+(this|the)?\s*(folder|directory|path)\b/i,
  /\bmonitor\s+(changes|files?|directory|folder)\b/i,
  /\bwhen\s+(an?\s+)?(email|webhook|file|message)\s+(arrives|comes|is\s+received|drops)\b/i,
  /\b(remind|alert|notify)\s+me\s+(when|to|every)\b/i,
  /\bset\s+up\s+(a\s+)?(cron|schedule|trigger|watcher|webhook)\b/i,
];

// ── System-path heuristic for file_* tool sandbox tips ─────────────────────

const SYSTEM_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /^\/etc\b/i,
  /^\/System\b/i,
  /^\/Library\/System\b/i,
  /^\/usr\/(s)?bin\b/i,
  /^[A-Z]:\\Windows\b/i,
  /^[A-Z]:\\Program\s+Files\b/i,
  /\\System32\\/i,
];

function isSystemPath(p: string): boolean {
  if (typeof p !== 'string' || p.length === 0) return false;
  return SYSTEM_PATH_PATTERNS.some((r) => r.test(p));
}

// ── Classifiers (pure) ─────────────────────────────────────────────────────

/** sandbox slot — destructive shell or system-path write. */
function classifySandbox(call: { name: string; arguments?: unknown }): boolean {
  const args = (call.arguments ?? {}) as Record<string, unknown>;
  if (call.name === 'shell_exec') {
    const cmd = typeof args.command === 'string' ? args.command : '';
    if (cmd.length === 0) return false;
    const cls = classifyCommand(cmd);
    return cls.tier === 'caution' || cls.tier === 'dangerous';
  }
  if (call.name === 'file_write' || call.name === 'file_delete'
   || call.name === 'file_move'  || call.name === 'file_patch') {
    const target = typeof args.path === 'string' ? args.path
                 : typeof args.target === 'string' ? args.target
                 : '';
    return isSystemPath(target);
  }
  return false;
}

/** browser_depth slot — any browser_* tool fires the suggestion when off. */
function classifyBrowserDepth(call: { name: string }): boolean {
  return call.name.startsWith('browser_');
}

/** daemon_scheduling slot — keyword regex on initial message. */
function classifySchedulingIntent(message: string): boolean {
  if (typeof message !== 'string' || message.length < 6) return false;
  return SCHEDULING_PATTERNS.some((r) => r.test(message));
}

// ── Singleton ──────────────────────────────────────────────────────────────

const DEFAULT_BUDGET_PER_SESSION = 2;

export interface BuildSuggestionEngineOptions {
  /** Override the budget. Default 2. */
  budgetPerSession?: number;
  /**
   * Override the runtime-toggles read seam. Tests inject a stub.
   * Production uses the singleton.
   */
  runtimeTogglesGetter?: () => ReturnType<typeof getRuntimeToggles>;
}

export function buildSuggestionEngine(
  opts: BuildSuggestionEngineOptions = {},
): SuggestionEngine {
  const budget = opts.budgetPerSession ?? DEFAULT_BUDGET_PER_SESSION;
  const getRT = opts.runtimeTogglesGetter ?? (() => getRuntimeToggles());

  const firedSlots: Set<SuggestionSlot> = new Set();
  let dismissedSession = false;

  function permanentlyOff(): boolean {
    try {
      // 'suggestions' is wired as a runtime toggle key via Phase 8b
      // schema extension. When the user has typed `/suggestions off`
      // (persisted to config.yaml runtime_toggles.suggestions=false),
      // the toggle reports off and we skip every classification.
      return !getRT().isEnabled('suggestions' as never);
    } catch {
      // Defensive — if the toggle key isn't registered yet we treat
      // suggestions as on (the default).
      return false;
    }
  }

  function canFire(slot: SuggestionSlot): boolean {
    if (dismissedSession) return false;
    if (permanentlyOff()) return false;
    if (firedSlots.has(slot)) return false;
    if (firedSlots.size >= budget) return false;
    // Only suggest when the relevant subsystem is OFF — otherwise the
    // tip is noise. Mapping: slot → underlying runtimeToggles key.
    try {
      switch (slot) {
        case 'sandbox':           if (getRT().isEnabled('sandbox')) return false; break;
        case 'browser_depth':     if (getRT().isEnabled('browser_depth')) return false; break;
        case 'tce_recovery':      if (getRT().isEnabled('tce')) return false; break;
        case 'daemon_scheduling':
          // No matching toggle — daemon mode is a process-level
          // boolean (AIDEN_DAEMON). Suggest only when daemon is off,
          // which we detect by reading the env var (the daemon
          // toggle isn't part of runtime_toggles by design).
          if (process.env.AIDEN_DAEMON === '1') return false;
          break;
      }
    } catch { /* defensive */ }
    return true;
  }

  function build(slot: SuggestionSlot): Suggestion {
    return { slot, message: suggestionMessageFor(slot) };
  }

  return {
    checkToolCall(call) {
      if (!call || typeof call.name !== 'string') return null;
      if (classifyBrowserDepth(call) && canFire('browser_depth')) {
        return build('browser_depth');
      }
      if (classifySandbox(call) && canFire('sandbox')) {
        return build('sandbox');
      }
      return null;
    },
    checkInitialMessage(message) {
      if (classifySchedulingIntent(message) && canFire('daemon_scheduling')) {
        return build('daemon_scheduling');
      }
      return null;
    },
    recordFired(slot) {
      firedSlots.add(slot);
    },
    dismissAll() {
      dismissedSession = true;
    },
    snapshot() {
      return {
        firedSlots:       [...firedSlots],
        dismissedSession,
        permanentlyOff:   permanentlyOff(),
        budgetRemaining:  Math.max(0, budget - firedSlots.size),
      };
    },
    _resetForTests() {
      firedSlots.clear();
      dismissedSession = false;
    },
  };
}

// ── Process-wide singleton ─────────────────────────────────────────────────

let _singleton: SuggestionEngine | null = null;

export function getSuggestionEngine(): SuggestionEngine {
  if (!_singleton) _singleton = buildSuggestionEngine();
  return _singleton;
}

export function _resetSuggestionEngineForTests(): void {
  if (_singleton) _singleton._resetForTests();
  _singleton = null;
}
