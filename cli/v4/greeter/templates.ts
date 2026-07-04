/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/greeter/templates.ts — v4.9.3 SLICE 1a.
 *
 * Pure-function templates per TemplateId. Identical ctx ⇒ identical
 * string out. No clock peek, no randomness, no env reads inside —
 * every dynamic value arrives via the TemplateContext bag, including
 * the two paint helpers.
 *
 * Render-site indent (2 spaces) and trailing newline are added by the
 * orchestrator, NOT by these templates. Templates return one logical
 * line of speech.
 */

import type { TemplateContext, TemplateId } from './types';
import path from 'node:path';

/**
 * The eight templates. Tier-1 entries (daemon-crashed, hook-auto-disabled)
 * are forward declarations — Slice 1's selectOffer never picks them. They
 * exist so v4.10's tier-1 scanners have a typed home to drop offers into.
 */
export const TEMPLATES: Record<TemplateId, (ctx: TemplateContext) => string> = {
  // ── Tier 1 (stubs — scanners deferred to v4.10) ----------------------
  'daemon-crashed': (ctx) =>
    `Daemon crashed mid-session. ${ctx.paintAccent('/daemon doctor')} for the postmortem.`,

  'hook-auto-disabled': (ctx) =>
    `A hook auto-disabled after repeated failures. ${ctx.paintAccent('/hooks audit')} for details.`,

  // ── Tier 2 (continuity) ----------------------------------------------
  'continuity-open-item': (ctx) =>
    `Last session left this open: ${ctx.paintMuted(`"${ctx.openItem ?? ''}"`)}.`,

  'continuity-decision': (ctx) =>
    `Last session: ${ctx.paintMuted(ctx.decision ?? '')}.`,

  'welcome-back': (ctx) =>
    `Welcome back. Last session ended ${ctx.hoursAgo ?? 0}h ago.`,

  // ── Tier 3 (environment) ---------------------------------------------
  'time-of-day-evening': (_ctx) =>
    `Good evening.`,

  'cwd-changed': (ctx) => {
    // Per user's prose suggestion: avoid "now" (implies temporal change).
    // Phrasing: "In <basename> this time (last session: <previous>)."
    const cur = ctx.cwd         ? path.basename(ctx.cwd)         : '';
    const prv = ctx.previousCwd ? path.basename(ctx.previousCwd) : '';
    return `In ${ctx.paintAccent(cur)} this time (last session: ${ctx.paintMuted(prv)}).`;
  },

  // ── Tier 4 (update) --------------------------------------------------
  // v4.14 — personified, advisory voice (tell, don't auto-update; the user
  // stays in control, same discipline as skill freshness). Reuses the boot
  // update-check cache via the greeter's scanUpdate — no new network path.
  'update-available': (ctx) =>
    `There's a newer version of me available (${ctx.installed ?? '?'} → ${ctx.latest ?? '?'}). ` +
    `Run ${ctx.paintAccent('/update install')} to upgrade — or just say the word.`,
};
