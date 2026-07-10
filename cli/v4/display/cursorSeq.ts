/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/display/cursorSeq.ts — bounded cursor/erase escape builders.
 *
 * The streaming markdown re-render (display.ts) moves the cursor up N lines and
 * clears the block it wrote so it can repaint it formatted. The original did
 * that with `\x1b[<N>F\x1b[J` — but `\x1b[J` (Erase-in-Display) clears from the
 * cursor to the PHYSICAL end of the screen, regardless of what sits below the
 * stream. That's a latent hazard: anything a later writer parks below the
 * stream's footprint is wiped by a re-render that only meant to redraw its own
 * lines.
 *
 * `clearLinesUpSeq(n)` is the bounded replacement: it moves up to the block
 * start and clears EXACTLY the n lines the stream wrote, in place — it never
 * emits `\x1b[J`, so it is physically incapable of touching a row below its own
 * block. With nothing below (today's behaviour) it is equivalent to the old
 * erase; the difference only shows when something IS parked below.
 *
 * Pure strings, no I/O — exhaustively unit-testable without a TTY.
 */

const ESC = '\x1b';

/**
 * Move up `n` lines to the block start and clear exactly those `n` lines,
 * leaving the cursor at the block start (column 0) ready to reprint. Never
 * `\x1b[J`. The caller's cursor must sit `n` rows below the block start (as it
 * does right after writing an `n`-line block), matching the old `\x1b[<n>F`
 * behaviour. Returns '' for n <= 0.
 */
export function clearLinesUpSeq(n: number): string {
  if (n <= 0) return '';
  // `\x1b[<n>F` = CPL: cursor up n lines to column 0 (the block start).
  let s = `${ESC}[${n}F${ESC}[2K`;                 // at block start; clear line 0
  for (let i = 1; i < n; i += 1) s += `${ESC}[1B${ESC}[2K`;  // down + clear each of lines 1..n-1
  if (n > 1) s += `${ESC}[${n - 1}A`;              // back up to block start (CUU keeps column 0)
  return s;
}
