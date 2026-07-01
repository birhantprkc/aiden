/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12 SH.1 — ★ honest-relabeling guard (the load-bearing anti-self-deception
 * deliverable). No user-facing string on the file-ACL/local path may claim the
 * shell-bypassable file guards are a "sandbox"/"containment". The /sandbox
 * command keeps its NAME (muscle memory) but its help + output must be honest,
 * and its `status` must render the honest ExecutionPolicy view.
 */
import { describe, it, expect, vi } from 'vitest';
import { sandbox } from '../../../cli/v4/commands/sandbox';
import { printStatus } from '../../../cli/v4/commands/_runtimeToggleHelpers';

/** Minimal capturing display + ctx shaped like SlashCommandContext. */
function makeCtx(args: string[]) {
  const lines: string[] = [];
  const push = (s: string) => { lines.push(s); };
  const display = {
    write:      (t: string) => push(t),
    dim:        (t: string) => push(t),
    info:       (t: string) => push(t),
    success:    (t: string) => push(t),
    warn:       (t: string) => push(t),
    printError: (t: string) => push(t),
  };
  const ctx = {
    args,
    display,
    config: { getValue: <T,>(_k: string, d: T) => d },
  } as any;
  return { ctx, lines };
}

describe('SH.1 — /sandbox command surface is honest (not shell containment)', () => {
  it('keeps the command NAME "sandbox" (muscle memory preserved)', () => {
    expect(sandbox.name).toBe('sandbox');
  });

  it('★ description does NOT claim containment — labels itself a guardrail', () => {
    const d = sandbox.description.toLowerCase();
    expect(d).toContain('guardrail');
    // It may mention "containment" ONLY to disclaim it ("NOT shell containment").
    expect(d).toMatch(/not\s+shell\s+containment/);
    // It must not describe the file ACLs as a "sandbox".
    expect(d).not.toMatch(/\bsandbox\b/);
  });

  it('★ status output renders the honest ExecutionPolicy view + shell-bypass caveat', async () => {
    // Note: getSandboxConfig() reads the runtime-toggles singleton, so the
    // reported backend (docker vs local) is environment-dependent. We assert
    // the backend-INDEPENDENT honesty invariant: the policy is surfaced AND it
    // always states a shell command can bypass the file guards.
    const { ctx, lines } = makeCtx(['status']);
    await sandbox.handler(ctx);
    const out = lines.join('\n').toLowerCase();
    expect(out).toContain('policy:');
    expect(out).toMatch(/containment=(none|docker)/);
    // the always-present honesty caveat, both backends:
    expect(out).toContain('a shell command can bypass them');
  });

  it('★ on/off flips print the not-containment disclaimer', async () => {
    const { ctx, lines } = makeCtx(['off']);
    await sandbox.handler(ctx);
    const out = lines.join('\n').toLowerCase();
    expect(out).toContain('not containment');
  });
});

describe('SH.1 — /sandbox status toggle label is honest', () => {
  it('printStatus labels the toggle "File guardrails" (not "Sandbox")', () => {
    const lines: string[] = [];
    const ctx = { display: { write: (t: string) => lines.push(t) } } as any;
    printStatus('sandbox', ctx);
    const out = lines.join('');
    expect(out).toMatch(/^File guardrails:/);
    expect(out).not.toMatch(/^Sandbox:/);
  });
});
