/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/greeter/selectOffer.ts — v4.9.3 SLICE 1a.
 *
 * Pure-function priority selector. Given the post-reconcile scan +
 * history + (optional) distillation snippet, returns at most one
 * `Offer` to render. Returns null when nothing wins (silence rule).
 *
 * Tier ordering: 1 > 2 > 3 > 4. Within a tier, the first detected
 * candidate wins (no scoring beyond the order listed below).
 *
 * Decay (applied per tier): an offer whose `id` exists in history.offers
 * with response === 'ignored' AND whose offeredAt is newer than the
 * per-tier window is SUPPRESSED. Exception: welcome-back has no decay —
 * it always fires when the threshold is crossed.
 */

import {
  type GreeterHistory,
  type Offer,
  type ScanResult,
  type TemplateContext,
  type TemplateId,
  DECAY_DAYS_ENVIRONMENT,
  DECAY_DAYS_UPDATE,
  WELCOME_BACK_THRESHOLD_HOURS,
} from './types';
import { TEMPLATES } from './templates';

/**
 * The selector takes a `paint` bag rather than building one — keeps the
 * function pure (no display dependency). Orchestrator supplies the
 * paint helpers from the live Display.
 *
 * Continuity inputs (openItem / lastDecision) are passed in
 * pre-extracted from the last distillation; this file does not touch
 * the distillation store directly so it stays pure.
 */
export interface SelectOfferInput {
  scan:           ScanResult;
  history:        GreeterHistory;
  now:            Date;
  paintMuted:     (s: string) => string;
  paintAccent:    (s: string) => string;
  /** Most-recent distillation's open_items[0] (or null when none). */
  openItem?:      string | null;
  /** Most-recent distillation's decisions[0] (or null when none). */
  lastDecision?:  string | null;
}

export function selectOffer(input: SelectOfferInput): Offer | null {
  // Greeter respects the kill switch absolutely.
  if (input.history.disabled) return null;

  const today = isoDateLocal(input.now);

  // ── Tier 2: continuity ----------------------------------------------
  // The orchestrator wires open_items + decisions from the most-recent
  // distillation. Prefer open-item over decision (open work is more
  // actionable; closed decisions are recap).
  if (input.openItem && input.openItem.length > 0) {
    return buildOffer('continuity-open-item', 2, undefined, {
      openItem: input.openItem,
    }, input);
  }
  if (input.lastDecision && input.lastDecision.length > 0) {
    return buildOffer('continuity-decision', 2, undefined, {
      decision: input.lastDecision,
    }, input);
  }

  // welcome-back: always fires when hoursSinceLastSession >= 24, no
  // decay. (Per dispatch: not really an offer — a continuity signal.)
  if (
    input.scan.hoursSinceLastSession !== null &&
    input.scan.hoursSinceLastSession >= WELCOME_BACK_THRESHOLD_HOURS
  ) {
    return buildOffer('welcome-back', 2, undefined, {
      hoursAgo: input.scan.hoursSinceLastSession,
    }, input);
  }

  // ── Tier 3: environment ---------------------------------------------
  // Both gated on no-tier-2-fired (handled implicitly by being later in
  // the function) AND not-in-3-day-decay-window.
  if (input.scan.hourOfDay >= 18) {
    const id = `time-of-day-evening-${today}`;
    if (!isDecayedRecently(id, input.history, DECAY_DAYS_ENVIRONMENT, input.now)) {
      return buildOffer('time-of-day-evening', 3, undefined, {}, input, id);
    }
  }
  if (input.scan.cwdChanged) {
    const id = `cwd-changed-${today}`;
    if (!isDecayedRecently(id, input.history, DECAY_DAYS_ENVIRONMENT, input.now)) {
      return buildOffer('cwd-changed', 3, undefined, {
        cwd:         input.scan.cwd,
        previousCwd: input.history.lastCwd,
      }, input, id);
    }
  }

  // ── Tier 4: update --------------------------------------------------
  if (input.scan.update) {
    const id = `update-available-${input.scan.update.latest}`;
    if (!isDecayedRecently(id, input.history, DECAY_DAYS_UPDATE, input.now)) {
      return buildOffer('update-available', 4, '/update install', {
        installed: input.scan.update.installed,
        latest:    input.scan.update.latest,
      }, input, id);
    }
  }

  return null;  // silence rule
}

// ── helpers ----------------------------------------------------------

/**
 * True iff history contains an `ignored` record for `id` whose age is
 * within the decay window. Pending offers do NOT suppress — only
 * ignored ones do (caller has logic for re-firing if the user just
 * didn't see it).
 */
function isDecayedRecently(
  id:        string,
  history:   GreeterHistory,
  days:      number,
  now:       Date,
): boolean {
  const cutoffMs = now.getTime() - days * 24 * 60 * 60 * 1000;
  return history.offers.some((o) =>
    o.id === id &&
    o.response === 'ignored' &&
    Date.parse(o.offeredAt) >= cutoffMs,
  );
}

/** YYYY-MM-DD in the local timezone (matches the "good evening at 6pm
 *  local time" intent of the time-of-day scanner). */
function isoDateLocal(d: Date): string {
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function buildOffer(
  templateId:     TemplateId,
  tier:           1 | 2 | 3 | 4,
  expectedAction: string | undefined,
  data:           Omit<TemplateContext, 'paintMuted' | 'paintAccent'>,
  input:          SelectOfferInput,
  customId?:      string,
): Offer {
  const ctx: TemplateContext = {
    ...data,
    paintMuted:  input.paintMuted,
    paintAccent: input.paintAccent,
  };
  return {
    id:             customId ?? `${templateId}-${isoDateLocal(input.now)}`,
    templateId,
    tier,
    expectedAction,
    speech:         TEMPLATES[templateId](ctx),
  };
}
