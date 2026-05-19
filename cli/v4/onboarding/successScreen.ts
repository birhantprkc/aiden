/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/onboarding/successScreen.ts — ONB1 slice 8.
 *
 * Replaces the wizard's prior "Setup Complete" box that told the
 * user to re-run `aiden` to start chatting. We DO NOT exit — the
 * wizard already returns to the boot path, which then drops into
 * the REPL. The old message was a lie of omission. The new screen
 * says exactly what happens next:
 *
 *     ──────────────────────────────────────────────────────────
 *
 *       All set!
 *
 *       Aiden is ready. Try these to start:
 *
 *       ▸ summarize the files in this folder
 *       ▸ what's running on my computer right now
 *       ▸ research the latest in AI agents and save to notes.md
 *
 *       Or just say hi.
 *
 *     ──────────────────────────────────────────────────────────
 *
 * Width-responsive: collapses example bullets to a single line at
 * <60 cols. Non-TTY callers see a plain `setup-complete` line so
 * scripted setups have a deterministic post-condition marker.
 */

import { c, separator, termWidth, bold } from '../../../core/v4/ui/theme';

export interface SuccessScreenOptions {
  out?: NodeJS.WriteStream;
  /** Override the example list. */
  examples?: string[];
}

const DEFAULT_EXAMPLES = [
  'summarize the files in this folder',
  'what\'s running on my computer right now',
  'research the latest in AI agents and save to notes.md',
];

export function renderSuccessScreen(opts: SuccessScreenOptions = {}): void {
  const out = opts.out ?? process.stdout;
  const examples = opts.examples ?? DEFAULT_EXAMPLES;

  if (!out.isTTY) {
    out.write('setup-complete\n');
    return;
  }

  const w = termWidth();
  const sepW = Math.min(w - 4, 64);
  const narrow = w < 60;

  out.write('\n  ' + separator(sepW) + '\n');
  out.write('\n  ' + bold(c.primary('All set!')) + '\n');
  out.write('\n  ' + c.text('Aiden is ready. Try these to start:') + '\n');
  out.write('\n');
  if (narrow) {
    // Compact: a single suggestion line + the muted hello fallback.
    out.write('  ' + c.muted('▸ ') + c.accent(examples[0]) + '\n');
  } else {
    for (const ex of examples) {
      out.write('  ' + c.muted('▸ ') + c.accent(ex) + '\n');
    }
  }
  out.write('\n  ' + c.muted('Or just say hi.') + '\n');
  out.write('\n  ' + separator(sepW) + '\n\n');
}
