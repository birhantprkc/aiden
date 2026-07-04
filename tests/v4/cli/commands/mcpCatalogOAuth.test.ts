/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.14 — catalog OAuth fields: the static device-client config carries through
 * to the persisted server config, and every OAuth entry declares an honest
 * `oauthVerified` flag (unverified until a real connect is proven).
 */
import { describe, it, expect } from 'vitest';

import { MCP_CATALOG, findCatalogEntry, catalogEntryToRawConfig } from '../../../../cli/v4/commands/mcpCatalog';

describe('catalog — OAuth static-client + verified flag', () => {
  it('every OAuth entry declares oauthVerified (honest; never silently "working")', () => {
    for (const e of MCP_CATALOG) {
      if (e.auth === 'oauth') {
        expect(typeof e.oauthVerified).toBe('boolean');
      }
    }
  });

  it('github carries a device-flow client config and is VERIFIED (proven live → one-tap connect)', () => {
    const gh = findCatalogEntry('github')!;
    expect(gh.auth).toBe('oauth');
    // v4.14 — device flow proven end-to-end against real GitHub, so github is
    // marked verified and offered for one-tap `/mcp connect`.
    expect(gh.oauthVerified).toBe(true);
    expect(gh.oauth?.deviceAuthorizationEndpoint).toBe('https://github.com/login/device/code');
    expect(gh.oauth?.scopes).toContain('repo');
    // Ships with an empty client id (no Aiden OAuth App registered yet) — the
    // user supplies their own PUBLIC client id via `/mcp connect` (prompted once,
    // then persisted) or --client-id. Device flow → no secret anywhere.
    expect(gh.oauth?.clientId).toBe('');
    expect(JSON.stringify(gh)).not.toMatch(/client_secret|clientSecret/);
  });

  it('catalogEntryToRawConfig carries oauth into the persisted http config', () => {
    const raw = catalogEntryToRawConfig(findCatalogEntry('github')!);
    expect(raw.type).toBe('http');
    if (raw.type === 'http') {
      expect(raw.http.oauth?.deviceAuthorizationEndpoint).toBe('https://github.com/login/device/code');
      expect(raw.http.oauth?.scopes).toContain('repo');
    }
  });

  it('stdio entries carry no oauth block (unaffected)', () => {
    const raw = catalogEntryToRawConfig(findCatalogEntry('memory')!);
    expect(raw.type).toBe('stdio');
    expect(JSON.stringify(raw)).not.toContain('oauth');
  });
});
