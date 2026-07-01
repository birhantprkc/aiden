/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/browser.ts — v4.12 B3.1 / B3.2a (attach-don't-own).
 *
 * `/browser attach [url] | status | detach` — connect Aiden to the USER'S
 * real Chrome over CDP (connectOverCDP), instead of spawning its own.
 *
 * Safety posture (B3.2a: Aiden ACTS, but only on its own controlled tab):
 *   - Explicit opt-in: attach is a deliberate command, gated by a confirm.
 *   - Blunt consent: the open-debug-port risk + the deferred-taint residual
 *     are stated up front, as part of consent — not a footnote.
 *   - Acts only on Aiden's dedicated tab (assertControlledTab) — never the
 *     user's other tabs; committing/external actions are confirm-gated.
 *   - Kill switch: /browser detach disconnects instantly, leaving Chrome running.
 *   - Aiden never closes the user's tabs/browser (see playwrightBridge pwDetach).
 */

import type { SlashCommand } from '../commandRegistry';
import { pwAttach, pwDetach, pwStop, pwBrowserStatus, pwListTabs, pwSwitchControl } from '../../../core/playwrightBridge';

const DEFAULT_ENDPOINT = 'http://127.0.0.1:9222';

/** OS-specific Chrome launch command with a DEDICATED debugging profile. */
function launchHint(): string {
  if (process.platform === 'win32') {
    return '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222 --user-data-dir="%TEMP%\\aiden-debug-profile"';
  }
  if (process.platform === 'darwin') {
    return '"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 --user-data-dir="$TMPDIR/aiden-debug-profile"';
  }
  return 'google-chrome --remote-debugging-port=9222 --user-data-dir="/tmp/aiden-debug-profile"';
}

export const browser: SlashCommand = {
  name: 'browser',
  description: 'Attach to your real Chrome over CDP (own tab, gated), status, stop, detach.',
  category: 'system',
  icon: '🖥️',
  handler: async (ctx) => {
    const sub = (ctx.args[0] ?? 'attach').toLowerCase();

    if (sub === 'status') {
      const s = pwBrowserStatus();
      ctx.display.info(`Browser mode: ${s.mode}`);
      if (s.mode === 'attached') {
        ctx.display.info(`  endpoint:       ${s.endpoint}`);
        ctx.display.info(`  controlled tab: ${s.controlledTabUrl ?? '(none)'}`);
        ctx.display.info('  Aiden acts only on this tab; committing/external actions are confirm-gated. /browser detach to stop.');
      }
      return {};
    }

    if (sub === 'tabs') {
      const r = await pwListTabs();
      if (!r.ok) { ctx.display.printError(`Couldn't list tabs: ${r.error}`); return {}; }
      if (r.tabs.length === 0) { ctx.display.info('No tabs tracked.'); return {}; }
      ctx.display.info('Tabs:');
      for (const t of r.tabs) {
        const flags = `${t.createdBy}${t.controlled ? ', controlled' : ''}${t.createdBy === 'user' ? ', not closeable' : ''}`;
        ctx.display.info(`  ${t.tab_id}  [${flags}]  ${t.title || '(untitled)'} — ${t.url || '(blank)'}`);
      }
      ctx.display.info('Aiden controls its own tabs freely. To control one of YOUR tabs: /browser control <tab_id>.');
      return {};
    }

    if (sub === 'control') {
      const tabId = (ctx.args[1] ?? '').trim();
      if (!tabId) { ctx.display.printError('Usage: /browser control <tab_id>  (see /browser tabs)'); return {}; }
      // Tier 2 — user-initiated designation to control a genuine user tab.
      if (ctx.confirm) {
        const ok = await ctx.confirm(`Let Aiden control ${tabId}? It will act on your tab (committing/external actions still confirm-gated; the tab is never closed).`);
        if (!ok) { ctx.display.info('Control cancelled.'); return {}; }
      }
      const r = await pwSwitchControl(tabId, { userDesignated: true });
      if (!r.ok) { ctx.display.printError(r.error ?? 'Could not switch control.'); return {}; }
      ctx.display.success(`Now controlling ${tabId}. (It stays non-closeable; B5 guards still apply.)`);
      return {};
    }

    if (sub === 'stop') {
      // B3.2b — interrupt the in-flight action but STAY attached: closes Aiden's
      // controlled tab (pending op rejects), recreates a fresh one.
      const r = await pwStop();
      if (!r.stopped) { ctx.display.info('Not attached — nothing to stop.'); return {}; }
      ctx.display.success('Stopped the current action — fresh tab ready, still attached. (Use /browser detach to disconnect.)');
      return {};
    }

    if (sub === 'detach') {
      if (pwBrowserStatus().mode !== 'attached') {
        ctx.display.info('Not attached — nothing to detach.');
        return {};
      }
      await pwDetach();
      ctx.display.success('Detached — your Chrome is left running. Back to the owned browser.');
      return {};
    }

    if (sub === 'attach') {
      const endpoint = ctx.args[1] || DEFAULT_ENDPOINT;

      // ── Blunt security warning — part of consent, not a footnote ──
      ctx.display.warn('⚠  Attaching to a remote-debugging Chrome is high-stakes:');
      ctx.display.warn('   • An open debug port lets ANY local process drive that browser — not just Aiden.');
      ctx.display.warn('   • Use a DEDICATED debugging profile, NOT your main one with all your logins.');
      ctx.display.warn('   • Keep it bound to 127.0.0.1 only.');
      ctx.display.warn('   • Aiden CAN act here — but only on its OWN tab, never your other tabs.');
      ctx.display.warn('   • Every committing or external action (purchase / submit / leaving the origin)');
      ctx.display.warn('     is confirm-gated through the approval engine before it runs.');
      ctx.display.warn('   • Residual: cross-page secret-exfil flow analysis is NOT yet built (a later slice) —');
      ctx.display.warn('     avoid attaching while sensitive authenticated sessions are open.');
      ctx.display.info('');
      ctx.display.info('1) Launch Chrome with remote debugging (dedicated profile):');
      ctx.display.info('   ' + launchHint());
      ctx.display.info(`2) Aiden connects to ${endpoint} and creates its OWN tab to act in (never grabs yours).`);
      ctx.display.info('');

      if (ctx.confirm) {
        const ok = await ctx.confirm(`Attach to the browser at ${endpoint}? (Aiden acts only on its own tab; committing/external actions are confirm-gated)`);
        if (!ok) { ctx.display.info('Attach cancelled.'); return {}; }
      }

      const r = await pwAttach(endpoint);
      if (!r.ok) {
        ctx.display.printError(`Couldn't attach to ${endpoint}: ${r.error}`);
        ctx.display.info('Launch Chrome with the command above first, then run /browser attach again.');
        return {};
      }
      ctx.display.success(`Attached to ${r.endpoint} — acting in a dedicated Aiden tab (${r.controlledTabUrl}).`);
      ctx.display.info('Aiden acts only on its own tab; committing/external actions are confirm-gated. Use /browser detach to stop at any time.');
      return {};
    }

    ctx.display.printError('Usage: /browser attach [url] | tabs | control <id> | status | stop | detach');
    return {};
  },
};
