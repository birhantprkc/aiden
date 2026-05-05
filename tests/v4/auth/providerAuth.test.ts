import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  resolveAidenPaths,
  ensureAidenDirsExist,
} from '../../../core/v4/paths';
import {
  OAuthProviderRegistry,
  OAuthProviderRuntime,
  type OAuthProvider,
  type OAuthUserAgent,
} from '../../../core/v4/auth/providerAuth';
import { saveTokens } from '../../../core/v4/auth/tokenStore';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-prov-'));
  process.env.AIDEN_TOKEN_KEY = 'test-key';
});
afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  delete process.env.AIDEN_TOKEN_KEY;
});

function makeProvider(overrides: Partial<OAuthProvider> = {}): OAuthProvider {
  return {
    id: 'demo-prov',
    displayName: 'Demo',
    async login() {
      return {
        accessToken: 'fresh',
        refreshToken: 'r-fresh',
        expiresInSeconds: 3600,
      };
    },
    async refresh(_token: string) {
      return {
        accessToken: 'refreshed',
        refreshToken: 'r-next',
        expiresInSeconds: 3600,
      };
    },
    ...overrides,
  };
}

const ua: OAuthUserAgent = {
  log: () => {},
  openBrowser: async () => {},
  prompt: async () => '',
  sleep: async () => {},
};

describe('OAuthProviderRegistry', () => {
  it('18. register / get / list / unregister', () => {
    const reg = new OAuthProviderRegistry();
    const a = makeProvider({ id: 'a' });
    const b = makeProvider({ id: 'b' });
    reg.register(b);
    reg.register(a);
    expect(reg.get('a')).toBe(a);
    expect(reg.list().map((p) => p.id)).toEqual(['a', 'b']); // sorted
    expect(reg.unregister('a')).toBe(true);
    expect(reg.get('a')).toBeUndefined();
  });

  it('19. duplicate registration throws', () => {
    const reg = new OAuthProviderRegistry();
    reg.register(makeProvider({ id: 'x' }));
    expect(() => reg.register(makeProvider({ id: 'x' }))).toThrow(
      /already registered/,
    );
  });
});

describe('OAuthProviderRuntime', () => {
  it('20. login persists tokens; getAccessToken returns the access token', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);
    const rt = new OAuthProviderRuntime(makeProvider(), paths);
    const persisted = await rt.login(ua);
    expect(persisted.accessToken).toBe('fresh');
    expect(persisted.expiresAtMs).toBeGreaterThan(Date.now());
    expect(await rt.getAccessToken()).toBe('fresh');
  });

  it('21. getAccessToken refreshes when within the pre-flight window', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);
    // Save expired tokens with a refresh token.
    await saveTokens(paths, {
      provider: 'demo-prov',
      accessToken: 'old',
      refreshToken: 'rt',
      expiresAtMs: Date.now() - 1000,
    });
    const refresh = vi.fn(async () => ({
      accessToken: 'NEW',
      refreshToken: 'rt2',
      expiresInSeconds: 3600,
    }));
    const rt = new OAuthProviderRuntime(
      makeProvider({ refresh: refresh as any }),
      paths,
    );
    const tok = await rt.getAccessToken();
    expect(tok).toBe('NEW');
    expect(refresh).toHaveBeenCalledOnce();
    // Persisted post-refresh.
    const second = await rt.getAccessToken();
    expect(second).toBe('NEW'); // still fresh, no second refresh
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('22. getAccessToken returns null when no refresh token is available', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);
    await saveTokens(paths, {
      provider: 'demo-prov',
      accessToken: 'old',
      refreshToken: null,
      expiresAtMs: Date.now() - 1000,
    });
    const rt = new OAuthProviderRuntime(makeProvider(), paths);
    expect(await rt.getAccessToken()).toBeNull();
  });

  it('23. logout clears the tokens file', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);
    const rt = new OAuthProviderRuntime(makeProvider(), paths);
    await rt.login(ua);
    expect(await rt.readTokens()).not.toBeNull();
    await rt.logout();
    expect(await rt.readTokens()).toBeNull();
  });
});
