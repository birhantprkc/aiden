import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  resolveAidenPaths,
  ensureAidenDirsExist,
} from '../../../core/v4/paths';
import {
  saveTokens,
  loadTokens,
  clearTokens,
  hasTokens,
  listAuthedProviders,
  isExpired,
  machineFingerprint,
  type OAuthTokens,
} from '../../../core/v4/auth/tokenStore';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-tokenstore-'));
  // Force a deterministic key across tests so encrypt+decrypt round-trips
  // even if the host changes between local + CI runs.
  process.env.AIDEN_TOKEN_KEY = 'test-key-do-not-use-in-prod';
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  delete process.env.AIDEN_TOKEN_KEY;
});

describe('tokenStore', () => {
  it('1. round-trips a token bundle through encrypt/decrypt', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);
    const tokens: OAuthTokens = {
      provider: 'demo',
      accessToken: 'access-abc',
      refreshToken: 'refresh-xyz',
      expiresAtMs: Date.now() + 3600_000,
      account: 'user@example.com',
    };
    await saveTokens(paths, tokens);
    const back = await loadTokens(paths, 'demo');
    expect(back?.accessToken).toBe('access-abc');
    expect(back?.refreshToken).toBe('refresh-xyz');
    expect(back?.account).toBe('user@example.com');
    expect(back?.savedAt).toBeDefined();
  });

  it('2. on-disk file does NOT contain the access token in plaintext', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);
    const tokens: OAuthTokens = {
      provider: 'demo',
      accessToken: 'sk_live_PLAINTEXT_SHOULD_NOT_APPEAR',
      expiresAtMs: Date.now() + 3600_000,
    };
    await saveTokens(paths, tokens);
    const file = path.join(tmpRoot, 'auth', 'demo.json');
    const text = await fs.readFile(file, 'utf8');
    expect(text).not.toContain('PLAINTEXT_SHOULD_NOT_APPEAR');
    // But the on-disk record IS valid JSON with iv/ciphertext/authTag.
    const parsed = JSON.parse(text);
    expect(parsed.iv).toMatch(/^[0-9a-f]+$/);
    expect(parsed.ciphertext).toMatch(/^[0-9a-f]+$/);
    expect(parsed.authTag).toMatch(/^[0-9a-f]+$/);
  });

  it('3. decrypt with the wrong machine key returns null and logs', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);
    await saveTokens(paths, {
      provider: 'demo',
      accessToken: 'a',
      expiresAtMs: Date.now() + 1000,
    });
    // Simulate copy-to-another-machine: change the key.
    process.env.AIDEN_TOKEN_KEY = 'a-different-machine-key';
    const errors: string[] = [];
    const back = await loadTokens(paths, 'demo', {
      onError: (m) => errors.push(m),
    });
    expect(back).toBeNull();
    expect(errors[0]).toMatch(/decrypt failed/);
    expect(errors[0]).toMatch(/another machine/);
  });

  it('4. clearTokens + hasTokens + listAuthedProviders behave', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);
    expect(await listAuthedProviders(paths)).toEqual([]);
    expect(await hasTokens(paths, 'demo')).toBe(false);
    await saveTokens(paths, {
      provider: 'demo',
      accessToken: 'a',
      expiresAtMs: 0,
    });
    expect(await hasTokens(paths, 'demo')).toBe(true);
    expect(await listAuthedProviders(paths)).toEqual(['demo']);
    await clearTokens(paths, 'demo');
    expect(await hasTokens(paths, 'demo')).toBe(false);
  });

  it('5. provider id is sanitised against path traversal', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);
    await saveTokens(paths, {
      provider: '../escape/me',
      accessToken: 'a',
      expiresAtMs: 0,
    });
    // No file outside paths.root/auth/
    const list = await listAuthedProviders(paths);
    expect(list.length).toBe(1);
    expect(list[0]).not.toContain('..');
    expect(list[0]).not.toContain('/');
  });

  it('6. isExpired and machineFingerprint helpers', () => {
    expect(isExpired({ provider: 'x', accessToken: 'a', expiresAtMs: 0 })).toBe(true);
    expect(
      isExpired({
        provider: 'x',
        accessToken: 'a',
        expiresAtMs: Date.now() + 3600_000,
      }),
    ).toBe(false);
    const fp = machineFingerprint();
    expect(fp).toMatch(/^[0-9a-f]{12}$/);
    expect(machineFingerprint()).toBe(fp); // stable across calls
  });
});
