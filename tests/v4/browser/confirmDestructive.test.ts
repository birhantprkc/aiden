/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12 B5.2 — confirm-destructive: a committing browser click is pre-classified
 * 'dangerous' in the executor (mirroring shell_exec) so the existing approval
 * engine confirms (manual) / denies (smart) it. Reuses B2.1's isDestructiveAction.
 */
import { describe, it, expect } from 'vitest';
import { ToolRegistry, type ToolHandler, type ToolContext } from '../../../core/v4/toolRegistry';
import { ApprovalEngine } from '../../../moat/approvalEngine';
import {
  classifyBrowserAction,
  getLeaseStore,
  isDestructiveAction,
  type AxRawDescriptor,
} from '../../../core/v4/browserState';
import { reResolveAndRetry } from '../../../tools/v4/browser/reResolve';

function desc(over: Partial<AxRawDescriptor> = {}): AxRawDescriptor {
  return {
    tag: 'button', roleAttr: '', inputType: '', ariaLabel: '', labelledByText: '',
    textContent: '', placeholder: '', alt: '', title: '',
    css_path: '#x', bbox: { x: 0, y: 0, w: 1, h: 1 }, frame_id: 'main', submit: false, ...over,
  };
}

describe('classifyBrowserAction', () => {
  it('ref → destructive lease (submit / verb name) → dangerous', () => {
    getLeaseStore().refresh(1, 'u', [
      desc({ ariaLabel: 'Place order', submit: false }), // @e1
      desc({ ariaLabel: 'Pay $20', submit: true }),       // @e2
      desc({ ariaLabel: 'Next page' }),                   // @e3 non-destructive
    ]);
    expect(classifyBrowserAction('browser_click', { ref: '@e1' })?.tier).toBe('dangerous');
    expect(classifyBrowserAction('browser_click', { ref: '@e2' })?.tier).toBe('dangerous');
    expect(classifyBrowserAction('browser_click', { ref: '@e3' })).toBeUndefined();
  });

  it('CSS/text target → verb-matched on the target string', () => {
    expect(classifyBrowserAction('browser_click', { target: 'Delete account' })?.tier).toBe('dangerous');
    expect(classifyBrowserAction('browser_click', { target: '#nav-home' })).toBeUndefined();
    expect(classifyBrowserAction('browser_click', { target: 'Read more' })).toBeUndefined();
  });

  it('type/fill are never destructive (no escalation), even on a submit lease', () => {
    getLeaseStore().refresh(1, 'u', [desc({ ariaLabel: 'Submit', submit: true })]); // @e1
    expect(classifyBrowserAction('browser_type', { ref: '@e1', text: 'x' })).toBeUndefined();
    expect(classifyBrowserAction('browser_fill', { fields: { '@e1': 'x' } })).toBeUndefined();
  });

  it('unknown ref → no lease → undefined (default caution applies)', () => {
    getLeaseStore().refresh(1, 'u', []);
    expect(classifyBrowserAction('browser_click', { ref: '@e9' })).toBeUndefined();
  });
});

// ── Executor integration: dangerous tier reaches the approval engine ─────────

const stubClick: ToolHandler = {
  schema: { name: 'browser_click', description: 'x', inputSchema: { type: 'object', properties: {} } },
  category: 'browser', mutates: true, toolset: 'browser',
  async execute() { return { success: true }; },
};
const baseCtx = (): ToolContext => ({ cwd: process.cwd(), paths: { authJson: '/tmp/x' } as never } as ToolContext);

describe('executor — confirm-destructive reaches the approval engine', () => {
  it('destructive click → riskTier dangerous at the approval gate', async () => {
    getLeaseStore().refresh(1, 'u', [desc({ ariaLabel: 'Place order', submit: true })]); // @e1
    const captured: { tier?: string; reason?: string } = {};
    const engine = new ApprovalEngine('smart', {
      riskAssess: async () => ({ tier: 'safe', rationale: 'untouched' }),
      onDecision: (req) => { captured.tier = req.riskTier; captured.reason = req.reason; },
    });
    const registry = new ToolRegistry();
    registry.register(stubClick);
    const exec = registry.buildExecutor({ ...baseCtx(), approvalEngine: engine });
    await exec({ id: '1', name: 'browser_click', arguments: { ref: '@e1' } });
    expect(captured.tier).toBe('dangerous');
    expect(captured.reason).toMatch(/destructive|committing/i);
  });

  it('non-destructive click → NOT dangerous (caution/safe path)', async () => {
    getLeaseStore().refresh(1, 'u', [desc({ ariaLabel: 'Next page' })]); // @e1
    const captured: { tier?: string } = {};
    const engine = new ApprovalEngine('smart', {
      riskAssess: async () => ({ tier: 'safe', rationale: 'untouched' }),
      onDecision: (req) => { captured.tier = req.riskTier; },
    });
    const registry = new ToolRegistry();
    registry.register(stubClick);
    const exec = registry.buildExecutor({ ...baseCtx(), approvalEngine: engine });
    await exec({ id: '1', name: 'browser_click', arguments: { ref: '@e1' } });
    expect(captured.tier).not.toBe('dangerous'); // defaulted → riskAssess → safe
  });
});

// ── Composition with B2.1: same classifier, two guard points, no conflict ────

describe('composition — confirm-before-act + suppress-blind-retry agree (one classifier)', () => {
  it('a destructive lease is BOTH confirm-flagged (executor) and retry-suppressed (observer)', async () => {
    getLeaseStore().refresh(1, 'u', [desc({ ariaLabel: 'Submit order', submit: true })]); // @e1
    // executor guard:
    expect(classifyBrowserAction('browser_click', { ref: '@e1' })?.tier).toBe('dangerous');
    // observer guard (B2.1): a stale destructive click is never re-resolved+retried:
    const rr = await reResolveAndRetry({ ref: '@e1', actionKind: 'click', staleReason: 'not visible', state_delta: [] });
    expect(rr.sidecar.suppressed).toBe('destructive');
    // both derive from the same primitive:
    expect(isDestructiveAction({ name: 'Submit order', submit: true }, 'click')).toBe(true);
  });
});
