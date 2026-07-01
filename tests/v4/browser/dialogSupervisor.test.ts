/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12 B4.2a — dialog / file-chooser / download supervisor.
 *
 * Dialogs are EVENT state (pending + recent-history + policy), not command-result
 * state. Policy: alert→accept; action-armed→accept (B5.2 consent inherited);
 * spontaneous confirm/beforeunload→dismiss; spontaneous prompt→park (round-trip via
 * browser_dialog); watchdog prevents a wedge. file events are passive (record only).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { classifyDialog } from '../../../core/v4/browserState';
import { getDialogSupervisor } from '../../../core/v4/browser/dialogState';
import { ToolRegistry, type ToolHandler, type ToolContext } from '../../../core/v4/toolRegistry';
import { ApprovalEngine } from '../../../moat/approvalEngine';
import { browserDialogTool } from '../../../tools/v4/browser/browserDialog';
import { browserUploadTool } from '../../../tools/v4/browser/browserUpload';

function fakeDialog(type: string, message: string) {
  return { type: () => type, message: () => message, accept: vi.fn(async () => {}), dismiss: vi.fn(async () => {}) };
}
const sup = getDialogSupervisor();
beforeEach(() => { sup.clear(); });

describe('classifyDialog (reuses DESTRUCTIVE_VERBS, not classifyBrowserAction)', () => {
  it('beforeunload → dangerous', () => expect(classifyDialog('beforeunload', '').tier).toBe('dangerous'));
  it('destructive-verb confirm → dangerous', () => expect(classifyDialog('confirm', 'Delete this item?').tier).toBe('dangerous'));
  it('destructive-verb prompt → dangerous', () => expect(classifyDialog('prompt', 'Type the name to confirm removal').tier).toBe('dangerous'));
  it('benign confirm → caution', () => expect(classifyDialog('confirm', 'Show more results?').tier).toBe('caution'));
  it('alert → caution', () => expect(classifyDialog('alert', 'Saved!').tier).toBe('caution'));
});

describe('dialog supervisor — pending + recent + policy', () => {
  it('alert → accepted + recorded in recent', async () => {
    const d = fakeDialog('alert', 'hi'); await sup.handle(d);
    expect(d.accept).toHaveBeenCalled();
    expect(sup.getRecent()[0]).toMatchObject({ type: 'alert', outcome: 'accepted' });
  });

  it('action-armed confirm → ACCEPTED (consent inherited from the action)', async () => {
    sup.arm();
    const d = fakeDialog('confirm', 'Delete?'); await sup.handle(d);
    expect(d.accept).toHaveBeenCalled();
    expect(d.dismiss).not.toHaveBeenCalled();
  });

  it('spontaneous confirm → DISMISSED + recorded (conservative)', async () => {
    const d = fakeDialog('confirm', 'Delete?'); await sup.handle(d);
    expect(d.dismiss).toHaveBeenCalled();
    expect(sup.getRecent()[0]).toMatchObject({ outcome: 'dismissed', tier: 'dangerous' });
  });

  it('spontaneous prompt → PARKED (held open, not auto-settled)', async () => {
    const d = fakeDialog('prompt', 'Your name?'); await sup.handle(d);
    expect(d.accept).not.toHaveBeenCalled();
    expect(d.dismiss).not.toHaveBeenCalled();
    expect(sup.getPending()).toMatchObject({ type: 'prompt', outcome: 'pending' });
  });

  it('★ prompt round-trip: respond(text) → dialog.accept(THE ACTUAL STRING)', async () => {
    const d = fakeDialog('prompt', 'Your name?'); await sup.handle(d); // parked
    await sup.respond('respond', 'Alice');
    expect(d.accept).toHaveBeenCalledWith('Alice');        // real string into page JS
    expect(sup.getRecent()[0]).toMatchObject({ responseText: 'Alice', outcome: 'accepted' });
    expect(sup.getPending()).toBeNull();
  });

  it('pre-armed prompt response → the next prompt accepts with it', async () => {
    sup.setPromptResponse('Bob');
    const d = fakeDialog('prompt', 'Your name?'); await sup.handle(d);
    expect(d.accept).toHaveBeenCalledWith('Bob');          // armed, not parked
    expect(sup.getPending()).toBeNull();
  });

  it('★ watchdog auto-dismisses a parked prompt (JS thread never wedges)', async () => {
    vi.useFakeTimers();
    try {
      const d = fakeDialog('prompt', 'Your name?'); await sup.handle(d); // parked
      expect(d.dismiss).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(31_000);
      expect(d.dismiss).toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});

describe('file-chooser / download — PASSIVE (detect + record, no auto-fulfill)', () => {
  it('records events without fulfilling them', () => {
    sup.recordFileEvent('filechooser', 'file input');
    sup.recordFileEvent('download', 'report.pdf');
    const kinds = sup.getFileEvents().map((e) => e.kind);
    expect(kinds).toContain('filechooser');
    expect(kinds).toContain('download');
  });
});

// ── Executor: B5.2 gate on browser_dialog / browser_upload ───────────────────

const baseCtx = (): ToolContext => ({ cwd: process.cwd(), paths: { authJson: '/tmp/x' } as never } as ToolContext);
async function tierFor(handler: ToolHandler, args: Record<string, unknown>): Promise<{ tier?: string; decision?: string }> {
  const cap: { tier?: string; decision?: string } = {};
  const engine = new ApprovalEngine('smart', {
    riskAssess: async () => ({ tier: 'safe', rationale: 'x' }),
    onDecision: (req, d) => { cap.tier = req.riskTier; cap.decision = d; },
  });
  const reg = new ToolRegistry();
  reg.register(handler);
  const exec = reg.buildExecutor({ ...baseCtx(), approvalEngine: engine });
  await exec({ id: '1', name: handler.schema.name, arguments: args });
  return cap;
}

describe('B4.2a — executor B5.2 gate', () => {
  it('browser_upload → dangerous at the gate (denied in smart before any FS touch)', async () => {
    const r = await tierFor(browserUploadTool, { selector: '#f', paths: ['/etc/passwd'] });
    expect(r.tier).toBe('dangerous');
    expect(r.decision).toBe('deny'); // never reaches execute → no browser launch
  });

  it('browser_dialog ACCEPT of a DANGEROUS parked dialog → dangerous at the gate', async () => {
    sup.clear();
    await sup.handle(fakeDialog('prompt', 'Delete account?')); // spontaneous → parked, dangerous
    const r = await tierFor(browserDialogTool, { action: 'accept' });
    expect(r.tier).toBe('dangerous');
    expect(r.decision).toBe('deny');
  });

  it('browser_dialog DISMISS is not escalated (dismissing is safe)', async () => {
    sup.clear();
    await sup.handle(fakeDialog('prompt', 'Delete account?')); // parked
    const r = await tierFor(browserDialogTool, { action: 'dismiss' });
    expect(r.tier).not.toBe('dangerous');
  });
});
