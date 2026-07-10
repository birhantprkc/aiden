import { describe, it, expect } from 'vitest';

import { handlerMutatesForCall } from '../../core/v4/handlerMutates';
import { decideTaskVerdict } from '../../core/v4/taskVerification';
import { TurnState } from '../../core/v4/turnState';
import type { HonestyTraceEntry } from '../../moat/honestyEnforcement';

/**
 * The live 4.14.7 failure, reproduced exactly. A read-only listing overflowed
 * its output cap (success:false, NO path/to/id); the model wrote the artifact on
 * a second call (success, HAS a path); ui_task_done claimed success. The verdict
 * failed because the failed listing was classified MUTATING. This is the test
 * verdictReconciliation.test.ts should have been — the failed call carries no
 * target, so same-target reconciliation can never reach it.
 */
const V_OK   = { ok: true,  confidence: 1, code: 'ok' as const };
const V_FAIL = { ok: false, confidence: 1, code: 'failed' as const, reason: 'output overflow — result truncated' };

// Production registry: shell_exec + file_write declare mutates:true; file_read false.
const resolveMutates = (name: string): boolean | undefined =>
  name === 'shell_exec' || name === 'file_write' ? true : name === 'file_read' ? false : undefined;

/** Stamp a trace entry the way aidenAgent does — handlerMutates via the seam. */
function entry(
  call: { name: string; arguments?: Record<string, unknown> },
  result: unknown,
  verification: unknown,
): HonestyTraceEntry {
  return {
    name: call.name, result, verification,
    handlerMutates: handlerMutatesForCall(call, resolveMutates),
  } as HonestyTraceEntry;
}

describe('shell_exec mutation classification — the real live trace', () => {
  const listing = { name: 'shell_exec', arguments: { command: 'Get-ChildItem $env:TEMP -Recurse' } };
  const write   = { name: 'shell_exec', arguments: { command: 'Set-Content -Path temp-files-recursive.txt -Value $x' } };

  it('the read-only listing is NOT a mutation (the write still is)', () => {
    expect(handlerMutatesForCall(listing, resolveMutates)).toBe(false);
    expect(handlerMutatesForCall(write, resolveMutates)).toBe(true);
  });

  it('read-only shell failure + later write success + ui_task_done → completed', () => {
    const trace: HonestyTraceEntry[] = [
      entry(listing, { exitCode: 1 }, V_FAIL),                                        // NO path/to/id
      entry(write,   { path: 'temp-files-recursive.txt', bytesWritten: 2470915 }, V_OK),
    ];
    expect(decideTaskVerdict(trace).verdict).toBe('completed');
  });
});

describe('the check can still say NO (true alarms stay red)', () => {
  const listing = { name: 'shell_exec', arguments: { command: 'Get-ChildItem $env:TEMP -Recurse' } };
  const setContent = { name: 'shell_exec', arguments: { command: 'Set-Content -Path out.txt -Value $x' } };

  it('i. a failed WRITE shell command (Set-Content) with no later success → verification_failed', () => {
    const trace: HonestyTraceEntry[] = [entry(setContent, { exitCode: 1 }, V_FAIL)];
    expect(decideTaskVerdict(trace).verdict).toBe('verification_failed');
  });

  it('ii. success claimed, but every mutating call FAILED (the read-only one is exempt) → verification_failed', () => {
    const trace: HonestyTraceEntry[] = [
      entry(listing,    { exitCode: 1 }, V_FAIL),   // read-only → exempt (not counted)
      entry(setContent, { exitCode: 1 }, V_FAIL),   // WRITE → mutating failure, un-redeemed
    ];
    expect(decideTaskVerdict(trace).verdict).toBe('verification_failed');
  });

  it('iii. a verified-ok write whose file is ABSENT on disk → verification_failed', () => {
    const trace: HonestyTraceEntry[] = [
      { name: 'file_write', result: { path: 'ghost.txt', bytesWritten: 10 }, handlerMutates: true, verification: V_OK } as HonestyTraceEntry,
    ];
    expect(decideTaskVerdict(trace, { pathExists: () => false }).verdict).toBe('verification_failed');
  });
});

describe('rollback safety — the checkpoint stays conservative (must NOT regress)', () => {
  it('a read-only shell_exec is non-mutating for VERIFICATION but the checkpoint/hoister gate stays mutating', () => {
    const listing = { name: 'shell_exec', arguments: { command: 'Get-ChildItem $env:TEMP -Recurse' } };
    // The trace stamp (verification) now sees it as a read …
    expect(handlerMutatesForCall(listing, resolveMutates)).toBe(false);
    // … but resolveMutates — what aidenAgent:1634 (checkpoint) and :1542 (parallel
    // hoister) consume — is UNCHANGED: shell_exec always mutates. The fix touches
    // only the trace stamp, never these two.
    expect(resolveMutates('shell_exec')).toBe(true);
  });

  it('markMutationOnLiveCheckpoint(shell_exec) makes the checkpoint NOT rollback-eligible', () => {
    const ts = new TurnState();
    ts.captureCheckpoint([], 0);
    expect(ts.findRestorableCheckpoint()).not.toBeNull();   // clean checkpoint IS restorable
    // aidenAgent gates this call on resolveMutates('shell_exec')===true (still true
    // for a read-only listing), so the mark still fires and blocks rollback.
    ts.markMutationOnLiveCheckpoint('shell_exec');
    expect(ts.findRestorableCheckpoint()).toBeNull();        // now blocked — un-doable mutation assumed
  });
});
