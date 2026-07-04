/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.14 — the SHIPPED default is the SAFE level, and "auto" is an explicit
 * opt-in. (Reverts the brief Partner-as-default experiment: shipping the
 * most-autonomous level by default is the wrong risk posture.)
 *
 *   • Default level is Assistant: acts, but ASKS at each write boundary.
 *   • Partner ("auto") is an OPT-IN: workspace-internal writes auto-allow.
 *   • FLOORS UNCHANGED AT EVERY LEVEL (Assistant AND Partner/auto):
 *     destructive / external-send / spend / out-of-scope still ASK; the
 *     hard-block set still DENIES.
 *   • Blanket grants (session/always) are recorded ONLY for safe classes; a
 *     destructive/external/spend call asks every single time.
 */
import { describe, it, expect, vi } from 'vitest';

import { ApprovalEngine, type ApprovalRequest } from '../../../moat/approvalEngine';
import {
  resolveAutonomyPolicy,
  isNeverBlanketAllow,
  type AutonomyLevel,
} from '../../../moat/autonomy';
import { resolveConfiguredAutonomyLevel } from '../../../core/v4/config';

const WS = '/work/space';
const cfg = (vals: Record<string, unknown>) => ({
  getValue: (<T,>(k: string, fb?: T): T => (k in vals ? (vals[k] as T) : (fb as T))),
});
function wreq(over: Partial<ApprovalRequest> & { toolName?: string } = {}): ApprovalRequest {
  return { toolName: 'file_write', category: 'write', args: { path: `${WS}/a.txt` }, ...over } as ApprovalRequest;
}
/** An engine at a given level, workspace rooted at WS. */
function engineAt(level: AutonomyLevel, promptUser = vi.fn().mockResolvedValue('deny')) {
  const e = new ApprovalEngine('smart', { promptUser });
  e.setAutonomyPolicy(resolveAutonomyPolicy(level, { workspaceRoots: [WS] }));
  return { e, promptUser };
}
/** An engine at whatever the DEFAULT resolves to (nothing configured). */
function defaultEngine(promptUser = vi.fn().mockResolvedValue('deny')) {
  const level = resolveConfiguredAutonomyLevel(cfg({}));
  return engineAt(level, promptUser);
}

// ── the default level ───────────────────────────────────────────────────────
describe('resolveConfiguredAutonomyLevel — the SAFE default', () => {
  it('nothing configured → Assistant (asks at each write boundary)', () => {
    expect(resolveConfiguredAutonomyLevel(cfg({}))).toBe('Assistant');
  });
  it('approval_mode NEVER raises the level: manual / smart / off all → Assistant', () => {
    expect(resolveConfiguredAutonomyLevel(cfg({ 'agent.approval_mode': 'manual' }))).toBe('Assistant');
    expect(resolveConfiguredAutonomyLevel(cfg({ 'agent.approval_mode': 'smart' }))).toBe('Assistant');
    expect(resolveConfiguredAutonomyLevel(cfg({ 'agent.approval_mode': 'off' }))).toBe('Assistant');
  });
  it('explicit agent.autonomy always wins (incl. the persisted /auto opt-in)', () => {
    expect(resolveConfiguredAutonomyLevel(cfg({ 'agent.autonomy': 'Observer' }))).toBe('Observer');
    expect(resolveConfiguredAutonomyLevel(cfg({ 'agent.autonomy': 'Partner' }))).toBe('Partner');
    expect(resolveConfiguredAutonomyLevel(cfg({ 'agent.autonomy': 'Assistant', 'agent.approval_mode': 'off' }))).toBe('Assistant');
  });
  it('a garbage agent.autonomy never RAISES — falls back to the safe default', () => {
    expect(resolveConfiguredAutonomyLevel(cfg({ 'agent.autonomy': 'Superuser' }))).toBe('Assistant');
  });
});

// ── default (Assistant) ASKS on writes; auto (Partner) is quiet ──────────────
describe('safe default asks on writes; auto opt-in is quiet on safe workspace writes', () => {
  it('DEFAULT (Assistant): a workspace-internal write ASKS (safe-by-default)', async () => {
    const { e, promptUser } = defaultEngine();
    expect(await e.checkApproval(wreq({ args: { path: `${WS}/src/x.ts` } }))).toBe(false);
    expect(promptUser).toHaveBeenCalledOnce();
  });
  it('AUTO (Partner opt-in): a workspace-internal write auto-allows (zero prompt)', async () => {
    const { e, promptUser } = engineAt('Partner');
    expect(await e.checkApproval(wreq({ args: { path: `${WS}/src/x.ts` } }))).toBe(true);
    expect(promptUser).not.toHaveBeenCalled();
  });
  it('AUTO (Partner): a RELATIVE-path workspace write auto-allows', async () => {
    const { e, promptUser } = engineAt('Partner');
    expect(await e.checkApproval(wreq({ args: { path: 'notes/today.md' } }))).toBe(true);
    expect(promptUser).not.toHaveBeenCalled();
  });
  it('reads always allow at BOTH levels (category read short-circuits)', async () => {
    for (const level of ['Assistant', 'Partner'] as const) {
      const { e, promptUser } = engineAt(level);
      expect(await e.checkApproval(wreq({ toolName: 'file_read', category: 'read', args: { path: '/anywhere/at/all' } }))).toBe(true);
      expect(promptUser).not.toHaveBeenCalled();
    }
  });
});

// ── FLOORS unchanged — still ASK / DENY at EVERY level, incl. auto ───────────
describe.each(['Assistant', 'Partner'] as const)('floors STILL gate at level %s', (level) => {
  it('destructive (dangerous) still ASKS', async () => {
    const { e, promptUser } = engineAt(level);
    expect(await e.checkApproval(wreq({ toolName: 'file_delete', riskTier: 'dangerous' }))).toBe(false);
    expect(promptUser).toHaveBeenCalledOnce();
  });
  it('an out-of-workspace write still ASKS', async () => {
    const { e, promptUser } = engineAt(level);
    expect(await e.checkApproval(wreq({ args: { path: '/etc/hosts' } }))).toBe(false);
    expect(promptUser).toHaveBeenCalledOnce();
  });
  it('an ESCAPING relative path (../) resolves out-of-scope and ASKS', async () => {
    const { e, promptUser } = engineAt(level);
    expect(await e.checkApproval(wreq({ args: { path: '../../etc/passwd' } }))).toBe(false);
    expect(promptUser).toHaveBeenCalledOnce();
  });
  it('an external send still ASKS', async () => {
    const { e, promptUser } = engineAt(level);
    expect(await e.checkApproval(wreq({ toolName: 'send_message', category: 'network', args: {} }))).toBe(false);
    expect(promptUser).toHaveBeenCalledOnce();
  });
  it('an external SPEND still ASKS', async () => {
    const { e, promptUser } = engineAt(level);
    expect(await e.checkApproval(wreq({ toolName: 'api_call', effects: { externalSpend: true }, args: {} }))).toBe(false);
    expect(promptUser).toHaveBeenCalledOnce();
  });
  it('the hard-block set is DENIED without a prompt (even if promptUser would allow)', async () => {
    const { e, promptUser } = engineAt(level, vi.fn().mockResolvedValue('allow'));
    expect(await e.checkApproval(wreq({ toolName: 'shell_exec', category: 'execute', args: { command: 'rm -rf /' } }))).toBe(false);
    expect(promptUser).not.toHaveBeenCalled();
  });
});

// ── session-allow: safe categories suppress re-prompt; floors never do ───────
describe('blanket session-allow — safe suppresses, destructive/external/spend never', () => {
  it('approving Session on a SAFE prompted write suppresses the re-prompt for the same category', async () => {
    const promptUser = vi.fn().mockResolvedValue('allow_session');
    const e = new ApprovalEngine('smart', { promptUser });
    e.setAutonomyPolicy(resolveAutonomyPolicy('Assistant', { workspaceRoots: [WS] }));
    const req = wreq({ args: { path: `${WS}/report.txt` } });
    expect(await e.checkApproval(req)).toBe(true);   // 1st: prompted → session-allowed
    expect(await e.checkApproval(req)).toBe(true);   // 2nd: same signature → suppressed
    expect(promptUser).toHaveBeenCalledOnce();        // only ONE prompt for the whole category
  });

  it('a DESTRUCTIVE call asks EVERY time even when the user picks Session', async () => {
    const promptUser = vi.fn().mockResolvedValue('allow_session');
    const e = new ApprovalEngine('smart', { promptUser });
    e.setAutonomyPolicy(resolveAutonomyPolicy('Partner', { workspaceRoots: [WS] }));
    const del = wreq({ toolName: 'file_delete', riskTier: 'dangerous', args: { path: `${WS}/a.txt` } });
    expect(await e.checkApproval(del)).toBe(true);    // one-time allow (ran once)
    expect(await e.checkApproval(del)).toBe(true);
    expect(promptUser).toHaveBeenCalledTimes(2);      // NOT blanket — asked both times
  });

  it('an EXTERNAL send asks every time even when Session is picked', async () => {
    const promptUser = vi.fn().mockResolvedValue('allow_session');
    const e = new ApprovalEngine('smart', { promptUser });
    e.setAutonomyPolicy(resolveAutonomyPolicy('Partner', { workspaceRoots: [WS] }));
    const send = wreq({ toolName: 'send_message', category: 'network', args: { to: 'x' } });
    await e.checkApproval(send);
    await e.checkApproval(send);
    expect(promptUser).toHaveBeenCalledTimes(2);
  });

  it('even allow_always does NOT persist a blanket for a destructive call', async () => {
    const persistAllow = vi.fn();
    const promptUser = vi.fn().mockResolvedValue('allow_always');
    const e = new ApprovalEngine('smart', { promptUser, persistAllow });
    e.setAutonomyPolicy(resolveAutonomyPolicy('Partner', { workspaceRoots: [WS] }));
    const del = wreq({ toolName: 'file_delete', riskTier: 'dangerous', args: { path: `${WS}/a.txt` } });
    await e.checkApproval(del);
    expect(persistAllow).not.toHaveBeenCalled();       // never written to the permanent allowlist
  });
});

// ── the never-blanket predicate ──────────────────────────────────────────────
describe('isNeverBlanketAllow — the floor classifier', () => {
  it('true for destructive / irreversible / external-send / spend', () => {
    expect(isNeverBlanketAllow(wreq({ riskTier: 'dangerous' }))).toBe(true);
    expect(isNeverBlanketAllow(wreq({ effects: { irreversible: true } }))).toBe(true);
    expect(isNeverBlanketAllow(wreq({ toolName: 'send_message' }))).toBe(true);
    expect(isNeverBlanketAllow(wreq({ effects: { externalSpend: true } }))).toBe(true);
  });
  it('false for an ordinary safe write', () => {
    expect(isNeverBlanketAllow(wreq())).toBe(false);
  });
});
