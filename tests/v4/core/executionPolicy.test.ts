/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12 SH.1 — ExecutionPolicy unified HONEST read-model.
 *
 * The whole point of SH.1 is anti-self-deception: this object must NOT claim
 * containment the shell can bypass. Tests assert the honesty invariants:
 *   - local backend ⇒ containment='none', fileGuardsAdvisory=true, and a note
 *     that says the file guards do NOT contain the shell;
 *   - docker backend ⇒ containment='docker', fileGuardsAdvisory=false;
 *   - approval mode flows through to shell/externalSideEffects honestly;
 *   - the summary line never calls a local-backend guard "containment".
 */
import { describe, it, expect } from 'vitest';
import { readSandboxConfig } from '../../../core/v4/sandboxConfig';
import {
  describeExecutionPolicy,
  summarizeExecutionPolicy,
} from '../../../core/v4/executionPolicy';

const localSandbox  = () => readSandboxConfig({ AIDEN_SANDBOX: '0' }); // backend=local
const dockerSandbox = () => readSandboxConfig({ AIDEN_SANDBOX: '1' }); // backend=docker

describe('ExecutionPolicy — ★ honesty under the LOCAL backend (no containment)', () => {
  it('reports containment=none and file guards as ADVISORY', () => {
    const p = describeExecutionPolicy({ sandbox: localSandbox(), approvalMode: 'smart', ssrfEnabled: true });
    expect(p.containment).toBe('none');
    expect(p.fileGuardsAdvisory).toBe(true);
  });

  it('★ carries a note stating the file guards do NOT contain the shell', () => {
    const p = describeExecutionPolicy({ sandbox: localSandbox(), approvalMode: 'smart', ssrfEnabled: true });
    const joined = p.notes.join(' ').toLowerCase();
    expect(joined).toContain('do not contain the shell');
    expect(joined).toContain('defense-in-depth');
  });

  it('★ the one-line summary never calls the local guard "containment"', () => {
    const p = describeExecutionPolicy({ sandbox: localSandbox(), approvalMode: 'smart', ssrfEnabled: true });
    const s = summarizeExecutionPolicy(p);
    expect(s).toMatch(/containment=none/);
    expect(s.toLowerCase()).toContain('not containment');
  });

  it('still surfaces the denylist + roots (advisory defense-in-depth for file_* tools)', () => {
    const p = describeExecutionPolicy({ sandbox: localSandbox(), approvalMode: 'smart', ssrfEnabled: true });
    expect(p.deniedPaths.length).toBeGreaterThan(0);
    expect(p.readRoots.length).toBeGreaterThan(0);
    expect(p.secrets).toBe('deny-direct-read');
  });
});

describe('ExecutionPolicy — DOCKER backend (a real, if weak, floor)', () => {
  it('reports containment=docker and file guards as NOT advisory', () => {
    const p = describeExecutionPolicy({ sandbox: dockerSandbox(), approvalMode: 'smart', ssrfEnabled: true });
    expect(p.containment).toBe('docker');
    expect(p.fileGuardsAdvisory).toBe(false);
  });

  it('is honest that the current container is only weakly hardened', () => {
    const p = describeExecutionPolicy({ sandbox: dockerSandbox(), approvalMode: 'smart', ssrfEnabled: true });
    expect(p.notes.join(' ').toLowerCase()).toMatch(/weakly hardened|weak/);
  });
});

describe('ExecutionPolicy — approval mode flows through honestly', () => {
  it('approval=off ⇒ shell=full, externalSideEffects=allow', () => {
    const p = describeExecutionPolicy({ sandbox: localSandbox(), approvalMode: 'off', ssrfEnabled: true });
    expect(p.approvalMode).toBe('off');
    expect(p.shell).toBe('full');
    expect(p.externalSideEffects).toBe('allow');
  });

  it('approval=smart ⇒ shell=ask-dangerous, externalSideEffects=ask', () => {
    const p = describeExecutionPolicy({ sandbox: localSandbox(), approvalMode: 'smart', ssrfEnabled: true });
    expect(p.shell).toBe('ask-dangerous');
    expect(p.externalSideEffects).toBe('ask');
  });
});

describe('ExecutionPolicy — network reflects SSRF guard + docker isolation', () => {
  it('ssrf on, local backend ⇒ network=public (private/loopback blocked, public allowed)', () => {
    const p = describeExecutionPolicy({ sandbox: localSandbox(), approvalMode: 'smart', ssrfEnabled: true });
    expect(p.network).toBe('public');
  });

  it('ssrf off, local backend ⇒ network=full (honest: no network guard)', () => {
    const p = describeExecutionPolicy({ sandbox: localSandbox(), approvalMode: 'smart', ssrfEnabled: false });
    expect(p.network).toBe('full');
  });

  it('docker backend + networkMode=none ⇒ network=none', () => {
    const sandbox = readSandboxConfig({ AIDEN_SANDBOX: '1', AIDEN_SANDBOX_NETWORK: 'none' });
    const p = describeExecutionPolicy({ sandbox, approvalMode: 'smart', ssrfEnabled: true });
    expect(p.network).toBe('none');
  });
});
