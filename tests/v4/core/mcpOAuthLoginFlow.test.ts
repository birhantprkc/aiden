/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12 Slice 3a.2 — loopback authorization-code+PKCE flow.
 * Loopback server tests use a REAL node:http server on 127.0.0.1; the flow
 * orchestration uses DI seams (startServer / makeState / fetchImpl) so no real
 * browser or network is needed. Persistence uses the REAL tokenStore.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http, { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveAidenPaths } from '../../../core/v4/paths';
import { loadTokens } from '../../../core/v4/auth/tokenStore';
import type { FetchImpl, OAuthUserAgent } from '../../../core/v4/auth/oauthFlow';
import { saveMcpOAuthConfig, mcpTokenId, type McpOAuthConfig } from '../../../core/v4/mcp/oauthDiscovery';
import {
  startLoopbackServer,
  buildAuthorizeUrl,
  runLoopbackAuthFlow,
  persistMcpTokens,
  loopbackRedirectUris,
  LOOPBACK_PORTS,
} from '../../../core/v4/mcp/oauthLoginFlow';

function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
      })
      .on('error', reject);
  });
}
const noopUa: OAuthUserAgent = {
  log: () => {},
  openBrowser: async () => {},
  prompt: async () => '',
  sleep: async () => {},
};

const CONFIG: McpOAuthConfig = {
  resource: 'http://srv.example/mcp',
  endpoints: {
    authorizationEndpoint: 'https://as.example/authorize',
    tokenEndpoint: 'https://as.example/token',
    registrationEndpoint: 'https://as.example/register',
    scopesSupported: ['mcp'],
  },
  clientId: 'dyn-1',
  redirectUris: ['http://127.0.0.1:8765/callback'],
};

describe('oauthLoginFlow — redirect registration set', () => {
  it('loopbackRedirectUris covers every loopback port (registered ⊇ bound)', () => {
    expect(loopbackRedirectUris()).toEqual(LOOPBACK_PORTS.map((p) => `http://127.0.0.1:${p}/callback`));
  });
});

describe('oauthLoginFlow — buildAuthorizeUrl (standard OAuth 2.1 + PKCE + RFC 8707)', () => {
  it('emits all standard params, S256, and the resource indicator', () => {
    const url = new URL(
      buildAuthorizeUrl(
        {
          authorizationEndpoint: 'https://as.example/authorize',
          clientId: 'c1',
          redirectUri: 'http://127.0.0.1:8765/callback',
          scope: 'mcp profile',
          resource: 'http://srv.example/mcp',
        },
        'CHALLENGE',
        'STATE',
      ),
    );
    expect(url.origin + url.pathname).toBe('https://as.example/authorize');
    const q = url.searchParams;
    expect(q.get('client_id')).toBe('c1');
    expect(q.get('response_type')).toBe('code');
    expect(q.get('redirect_uri')).toBe('http://127.0.0.1:8765/callback');
    expect(q.get('scope')).toBe('mcp profile');
    expect(q.get('state')).toBe('STATE');
    expect(q.get('code_challenge')).toBe('CHALLENGE');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('resource')).toBe('http://srv.example/mcp');
  });
});

describe('oauthLoginFlow — loopback callback server (real http)', () => {
  it('binds, captures code+state, serves a success page, closes', async () => {
    const loop = await startLoopbackServer({ ports: [18765] });
    expect(loop.redirectUri).toBe('http://127.0.0.1:18765/callback');
    const pending = httpGet(`${loop.redirectUri}?code=abc&state=xyz`);
    const cap = await loop.waitForCallback(2000);
    expect(cap).toEqual({ code: 'abc', state: 'xyz' });
    const resp = await pending;
    expect(resp.status).toBe(200);
    expect(resp.body).toContain('Authentication complete');
    await loop.close();
  });

  it('falls back to the next port on EADDRINUSE', async () => {
    // Windows allows a real double-bind (no SO_EXCLUSIVEADDRUSE), so simulate
    // EADDRINUSE deterministically via an injected server factory.
    const occupied = new Set([18790]);
    const fakeFactory = (() => {
      const ee = new EventEmitter() as EventEmitter & {
        listen: (port: number, host: string, cb: () => void) => unknown;
        close: (cb?: () => void) => unknown;
      };
      ee.listen = (port, _host, cb) => {
        if (occupied.has(port)) {
          const err: NodeJS.ErrnoException = new Error('EADDRINUSE');
          err.code = 'EADDRINUSE';
          setImmediate(() => ee.emit('error', err));
        } else {
          setImmediate(cb);
        }
        return ee;
      };
      ee.close = (cb) => { cb?.(); return ee; };
      return ee;
    }) as unknown as typeof createServer;

    const loop = await startLoopbackServer({ ports: [18790, 18791], createServerFn: fakeFactory });
    expect(loop.port).toBe(18791);
    await loop.close();
  });

  it('rejects on timeout', async () => {
    const loop = await startLoopbackServer({ ports: [18766] });
    await expect(loop.waitForCallback(40)).rejects.toThrow(/timed out/);
    await loop.close();
  });

  it('rejects + serves an error page on an error param', async () => {
    const loop = await startLoopbackServer({ ports: [18767] });
    const pending = httpGet(`${loop.redirectUri}?error=access_denied`);
    await expect(loop.waitForCallback(2000)).rejects.toThrow(/Authorization denied: access_denied/);
    const resp = await pending;
    expect(resp.status).toBe(400);
    expect(resp.body).toContain('Authorization failed');
    await loop.close();
  });
});

describe('oauthLoginFlow — runLoopbackAuthFlow', () => {
  const fakeLoop = (state: string) => async () => ({
    port: 8765,
    redirectUri: 'http://127.0.0.1:8765/callback',
    waitForCallback: async () => ({ code: 'authcode', state }),
    close: async () => {},
  });

  it('rejects on state mismatch (CSRF guard)', async () => {
    await expect(
      runLoopbackAuthFlow({
        config: CONFIG,
        server: 'srv',
        ua: noopUa,
        makeState: () => 'S1',
        startServer: fakeLoop('WRONG') as never,
        fetchImpl: (async () => ({ status: 200, text: async () => '{}' })) as FetchImpl,
      }),
    ).rejects.toThrow(/state mismatch/);
  });

  it('exchanges code+verifier (form body) and returns the token result', async () => {
    let captured: { input: string; init: { body?: string } } | undefined;
    const fetchImpl: FetchImpl = async (input, init) => {
      captured = { input, init };
      return {
        status: 200,
        text: async () => JSON.stringify({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600, scope: 'mcp' }),
      };
    };
    const result = await runLoopbackAuthFlow({
      config: CONFIG,
      server: 'srv',
      ua: noopUa,
      makeState: () => 'S1',
      startServer: fakeLoop('S1') as never,
      fetchImpl,
    });
    expect(captured?.input).toBe('https://as.example/token');
    const p = new URLSearchParams(captured!.init.body!);
    expect(p.get('grant_type')).toBe('authorization_code');
    expect(p.get('code')).toBe('authcode');
    expect(p.get('redirect_uri')).toBe('http://127.0.0.1:8765/callback');
    expect(p.get('client_id')).toBe('dyn-1');
    expect(p.get('code_verifier')).toBeTruthy();
    expect(p.get('resource')).toBe('http://srv.example/mcp');
    expect(result.accessToken).toBe('AT');
    expect(result.refreshToken).toBe('RT');
    expect(result.expiresInSeconds).toBe(3600);
  });
});

describe('oauthLoginFlow — persistMcpTokens (real tokenStore)', () => {
  let tmp: string;
  beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-mcp-login-')); process.env.AIDEN_TOKEN_KEY = 'test-key-3a2'; });
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); delete process.env.AIDEN_TOKEN_KEY; });

  it('stores absolute expiry and preserves extras.oauth from discovery', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmp });
    await saveMcpOAuthConfig(paths, 'srv', CONFIG); // 3a.1 metadata-only record
    const before = Date.now();
    await persistMcpTokens(paths, 'srv', {
      accessToken: 'AT',
      refreshToken: 'RT',
      expiresInSeconds: 3600,
      extras: { scope: 'mcp' },
    });

    const t = await loadTokens(paths, mcpTokenId('srv'));
    expect(t?.accessToken).toBe('AT');
    expect(t?.refreshToken).toBe('RT');
    expect(t?.expiresAtMs).toBeGreaterThanOrEqual(before + 3_600_000);
    expect((t?.extras?.oauth as McpOAuthConfig).clientId).toBe('dyn-1'); // discovery config preserved
    expect(t?.extras?.scope).toBe('mcp'); // flow extras merged
  });
});
