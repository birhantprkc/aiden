/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/toolOutputCap.ts — v4.12 TOC.1 (Layer-1 per-tool output caps).
 *
 * Caps a tool's output AT THE BOUNDARY (before it enters context), mirroring how
 * the browser caps its snapshot/extract. Over cap → keep HEAD 40% + TAIL 60%
 * with an omitted-char marker.
 *
 * ★ Order matters: truncate FIRST, then strip ANSI, then redact
 * secrets AFTER truncation — so a secret split across the truncation boundary
 * can't leak. Redaction reuses the SAME primitives as B5.1 / MCP (scrubString's
 * SECRET_PATTERNS + McpCredentialFilter's CREDENTIAL_PATTERNS) — no hand-rolling.
 *
 * Under cap → BYTE-IDENTICAL passthrough (no marker, no ANSI strip, no redaction,
 * no handle), like OM.2's under-threshold path.
 */
import { scrubString } from './logger/redact';
import { McpCredentialFilter } from './mcp/credentialFilter';

export const DEFAULT_OUTPUT_CAP = 50_000;
const HEAD_FRACTION = 0.4;
// CSI + common single-char escapes (colour codes, cursor moves).
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;
const _filter = new McpCredentialFilter();

export interface CappedOutput {
  text: string;
  truncated: boolean;
  omittedChars: number;
}

/**
 * Cap tool output. Under `cap` → unchanged. Over → head40/tail60 + marker,
 * then ANSI-strip, then secret-redact (in that order).
 */
export function capToolOutput(raw: string, cap: number = DEFAULT_OUTPUT_CAP): CappedOutput {
  if (typeof raw !== 'string' || raw.length <= cap) {
    return { text: typeof raw === 'string' ? raw : '', truncated: false, omittedChars: 0 };
  }
  const headLen = Math.floor(cap * HEAD_FRACTION);
  const tailLen = cap - headLen;
  const omitted = raw.length - cap;
  // 1. truncate FIRST (on the raw wire bytes so the cap bounds the real size)
  let out = `${raw.slice(0, headLen)}\n[... ${omitted} chars omitted ...]\n${raw.slice(raw.length - tailLen)}`;
  // 2. strip ANSI
  out = out.replace(ANSI_RE, '');
  // 3. redact AFTER truncation — a boundary-split secret can't survive
  out = _filter.redact(scrubString(out));
  return { text: out, truncated: true, omittedChars: omitted };
}

/** Universal lossy-but-recoverable handle carried on a truncated result. */
export interface RecoverabilityHandle {
  truncated: true;
  summary: string;
  /** How to fetch the omitted part; null when the output is ephemeral. */
  full_output_ref: unknown;
  /** The concrete next action the model should take to recover the rest. */
  suggested_next: string;
}

/** Recoverability handle for a truncated shell/execute output (ephemeral — no stored ref). */
export function shellOutputHandle(omittedChars: number): RecoverabilityHandle {
  return {
    truncated: true,
    summary: `Output too large — kept the first ~40% and last ~60%, omitting ${omittedChars} chars in the middle. Secrets in the shown text were redacted.`,
    full_output_ref: null,
    suggested_next:
      'Re-run redirecting output to a file (e.g. `<command> > out.txt 2>&1`), then file_read with offset/limit to page the full output — or narrow the command (grep/head/tail).',
  };
}

/** Recoverability handle for a paginated file_read (points at the next page). */
export function fileReadHandle(pathRef: string, nextOffset: number, limit: number, total: number): RecoverabilityHandle {
  return {
    truncated: true,
    summary: `Showed ${Math.min(limit, total - (nextOffset - limit))} of ${total} chars.`,
    full_output_ref: { path: pathRef, offset: nextOffset, limit },
    suggested_next: `Call file_read again with offset=${nextOffset} (same limit) to read the next section.`,
  };
}
