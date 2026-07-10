/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/handlerMutates.ts — per-CALL mutation classification for the trace stamp.
 *
 * aidenAgent stamps each trace entry's `handlerMutates` at dispatch time. It used
 * the STATIC per-tool flag (`resolveMutates(call.name)`) — name only — so a
 * read-only `shell_exec` (Get-ChildItem, cat, rg …) that merely overflowed its
 * output cap was recorded as a MUTATING failure and failed the turn's verdict,
 * even though the approval layer already treats the same command as a read
 * (toolRegistry's `readOnlyShell`).
 *
 * This computes the flag PER CALL from the command string. It feeds ONLY the
 * trace entry's `handlerMutates` (verification): it does NOT touch
 * `resolveMutates` itself nor its two other consumers — the rollback checkpoint
 * (`markMutationOnLiveCheckpoint`) and the parallel read-only hoister — which
 * stay conservative (shell_exec always mutates), so a misclassified command can
 * never make rollback proceed thinking nothing happened.
 */

import { isReadOnlyCommand } from '../../moat/dangerousPatterns';

export interface MutatesCall {
  name:       string;
  arguments?: Record<string, unknown>;
}

export function handlerMutatesForCall(
  call: MutatesCall,
  resolveMutates?: (name: string) => boolean | undefined,
): boolean {
  const base = resolveMutates?.(call.name) ?? false;
  // Already read-only per the static flag (e.g. file_read), or an unknown tool
  // (undefined → false): keep it non-mutating.
  if (!base) return false;
  // shell_exec: a command isReadOnlyCommand PROVES read-only (rg/grep/ls/cat/
  // Get-ChildItem/… with no redirection, chaining, or dangerous pattern) is a
  // read, not a side effect — so a listing that merely overflowed its output cap
  // is not a mutating failure. isReadOnlyCommand is CONSERVATIVE (anything it
  // cannot prove read-only → false), so an absent / malformed / write / dangerous
  // command stays mutating. Unknown means mutating.
  if (call.name === 'shell_exec') {
    const cmd = call.arguments?.command;
    if (typeof cmd === 'string' && isReadOnlyCommand(cmd)) return false;
  }
  return base;   // = true
}
