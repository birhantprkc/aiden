/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.14 — one-tap `/mcp connect <name>`: collapse catalog-add → auth →
 * device-code into ONE command. These tests drive the wrapper through the
 * public `mcp` handler (so the dispatch is covered too) and stop at the auth
 * boundary network-free by omitting `ctx.paths` (handleAuth bails there) — the
 * live device-flow connect is the Shiva smoke, not a unit test. What IS proven
 * here: the honest-catalog gate, the add→auth orchestration, inline client-id
 * prompt + persistence (never an env var), skip-re-add, already-connected, and
 * that the old 3 commands are untouched.
 */
import { describe, it, expect, vi } from 'vitest';
import { mcp } from '../../../../cli/v4/commands/mcpManage';
import { isConnectable, findCatalogEntry } from '../../../../cli/v4/commands/mcpCatalog';
import { CommandRegistry, type SlashCommandContext } from '../../../../cli/v4/commandRegistry';

function fakeConfig(servers: Record<string, unknown> = {}) {
  const store: any = Object.keys(servers).length ? { mcp: { servers: { ...servers } } } : {};
  return {
    store,
    save: vi.fn(async () => {}),
    getValue: (key: string) => { let c: any = store; for (const p of key.split('.')) { if (c == null) return undefined; c = c[p]; } return c; },
    set: (key: string, val: unknown) => {
      const parts = key.split('.'); let c: any = store;
      for (let i = 0; i < parts.length - 1; i += 1) { if (typeof c[parts[i]] !== 'object' || c[parts[i]] == null) c[parts[i]] = {}; c = c[parts[i]]; }
      c[parts[parts.length - 1]] = val;
    },
  };
}
function fakeClient(over: Record<string, unknown> = {}) {
  return {
    list: () => [],
    get: () => undefined,
    connect: vi.fn(async (cfg: { name: string }) => ({ config: cfg, tools: [{ rawName: 't', prefixedName: `mcp_${cfg.name}_t` }], status: 'ready' })),
    ...over,
  };
}
function captured() {
  const o: any = { out: [] as string[] };
  o.info = (m: string) => o.out.push(`info:${m}`);
  o.warn = (m: string) => o.out.push(`warn:${m}`);
  o.dim = (m: string) => o.out.push(`dim:${m}`);
  o.write = (m: string) => o.out.push(m.replace(/\n$/, ''));
  o.success = (m: string) => o.out.push(`ok:${m}`);
  o.printError = (m: string, s?: string) => o.out.push(`err:${m}${s ? ` | ${s}` : ''}`);
  return o;
}
function buildCtx(args: string[], client: unknown, extra: Partial<SlashCommandContext> = {}) {
  const display = captured();
  const ctx = { args, rawArgs: args.join(' '), display: display as never, registry: new CommandRegistry(), mcpClient: client as never, ...extra } as SlashCommandContext;
  return { ctx, display };
}
const text = (d: any) => d.out.join('\n');
const githubEntry = () => findCatalogEntry('github')!;

describe('isConnectable — honest catalog', () => {
  it('a VERIFIED oauth entry (github, proven live) is connectable', () => {
    expect(isConnectable(githubEntry())).toBe(true);
  });
  it('an UNVERIFIED oauth entry is NOT connectable (never advertised)', () => {
    const unverified = { ...githubEntry(), oauthVerified: false };
    expect(isConnectable(unverified)).toBe(false);
  });
  it('a non-oauth entry connects directly (no verification gate)', () => {
    expect(isConnectable(findCatalogEntry('memory')!)).toBe(true);
  });
});

describe('/mcp connect — one-tap wrapper', () => {
  it('fresh github + --client-id: adds (ONE confirm) → persists the id → reaches authorize', async () => {
    const cfg = fakeConfig();
    const confirm = vi.fn(async () => true);
    const prompt = vi.fn(async () => 'should-not-ask');
    const { ctx, display } = buildCtx(['connect', 'github', '--client-id', 'Ov23-live'], fakeClient(), { config: cfg as never, confirm, prompt });
    await mcp.handler(ctx);
    const out = text(display);
    expect((cfg.getValue('mcp.servers.github') as any)?.http?.oauth?.clientId).toBe('Ov23-live'); // persisted, no env var
    expect(confirm).toHaveBeenCalledTimes(1);   // one add gate
    expect(prompt).not.toHaveBeenCalled();       // id supplied → no inline prompt
    expect(out).toMatch(/Added 'github'/);       // step 1 done
    expect(out).toMatch(/Cannot store tokens/);  // step 2 reached handleAuth (paths omitted → bails here, network-free)
  });

  it('missing client-id → prompts inline ONCE, then persists the prompted id (never env var)', async () => {
    const cfg = fakeConfig();
    const confirm = vi.fn(async () => true);
    const prompt = vi.fn(async () => 'Ov23-prompted');
    const { ctx } = buildCtx(['connect', 'github'], fakeClient(), { config: cfg as never, confirm, prompt });
    await mcp.handler(ctx);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect((cfg.getValue('mcp.servers.github') as any)?.http?.oauth?.clientId).toBe('Ov23-prompted');
  });

  it('blank inline client-id → clean abort, nothing added', async () => {
    const cfg = fakeConfig();
    const { ctx, display } = buildCtx(['connect', 'github'], fakeClient(), { config: cfg as never, confirm: vi.fn(async () => true), prompt: vi.fn(async () => '   ') });
    await mcp.handler(ctx);
    expect(cfg.getValue('mcp.servers.github')).toBeUndefined();
    expect(text(display)).toMatch(/No client id entered/);
  });

  it('already-added github: SKIPS re-add (no confirm), goes straight to authorize', async () => {
    const cfg = fakeConfig({ github: { type: 'http', http: { baseUrl: 'https://api.githubcopilot.com/mcp/', transport: 'streamable', oauth: { clientId: 'Ov23-stored', deviceAuthorizationEndpoint: 'https://github.com/login/device/code', scopes: [] } } } });
    const confirm = vi.fn(async () => true);
    const prompt = vi.fn(async () => 'x');
    const { ctx, display } = buildCtx(['connect', 'github'], fakeClient(), { config: cfg as never, confirm, prompt });
    await mcp.handler(ctx);
    const out = text(display);
    expect(confirm).not.toHaveBeenCalled();       // not re-added
    expect(prompt).not.toHaveBeenCalled();         // stored id → no prompt
    expect(out).toMatch(/already configured/);
    expect(out).toMatch(/Cannot store tokens/);    // proceeded to authorize
  });

  it('already CONNECTED github: reports it and does nothing else', async () => {
    const cfg = fakeConfig();
    const confirm = vi.fn(async () => true);
    const client = fakeClient({ get: () => ({ status: 'ready', tools: [{}, {}] }) });
    const { ctx, display } = buildCtx(['connect', 'github'], client, { config: cfg as never, confirm });
    await mcp.handler(ctx);
    expect(text(display)).toMatch(/already connected/);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('confirm=NO on a fresh add → clean stop, never reaches authorize', async () => {
    const cfg = fakeConfig();
    const confirm = vi.fn(async () => false);
    const { ctx, display } = buildCtx(['connect', 'github', '--client-id', 'X'], fakeClient(), { config: cfg as never, confirm, prompt: vi.fn() });
    await mcp.handler(ctx);
    expect(cfg.getValue('mcp.servers.github')).toBeUndefined();   // not added
    expect(text(display)).not.toMatch(/Cannot store tokens/);      // auth never attempted
  });

  it('unknown slug → error, no add, no auth', async () => {
    const { ctx, display } = buildCtx(['connect', 'nope'], fakeClient(), { config: fakeConfig() as never, confirm: vi.fn(async () => true) });
    await mcp.handler(ctx);
    expect(text(display)).toMatch(/No catalog entry 'nope'/);
  });
});

describe('old 3 commands still work (the wrapper is additive)', () => {
  it('/mcp catalog add memory still connects directly (non-oauth, unchanged)', async () => {
    const cfg = fakeConfig();
    const { ctx, display } = buildCtx(['catalog', 'add', 'memory'], fakeClient(), { config: cfg as never, confirm: vi.fn(async () => true) });
    await mcp.handler(ctx);
    expect(cfg.getValue('mcp.servers.memory')).toBeTruthy();
    expect(text(display)).toMatch(/Connected 'memory'/);
  });

  it('/mcp install github still adds + shows the MANUAL /mcp auth hint (not chained)', async () => {
    const cfg = fakeConfig();
    const { ctx, display } = buildCtx(['install', 'github'], fakeClient(), { config: cfg as never, confirm: vi.fn(async () => true) });
    await mcp.handler(ctx);
    expect(cfg.getValue('mcp.servers.github')).toBeTruthy();
    expect(text(display)).toMatch(/Run \/mcp auth github/);   // old two-step hint preserved
  });
});
