/**
 * tests/v4/mcp/install/clientPaths.test.ts — v4.9.0 Slice 2a.
 */
import { describe, it, expect } from 'vitest';
import { resolveClientPath } from '../../../../core/v4/mcp/install/clientPaths';

const HOME = '/home/u';
const APPDATA = 'C:\\Users\\u\\AppData\\Roaming';

describe('clientPaths — Slice 2a', () => {
  it('claude on macOS uses Library/Application Support', () => {
    const r = resolveClientPath('claude', { platform: 'darwin', homedir: HOME });
    // path.join on the host uses the host's separator, so compare via
    // forward-slash normalisation rather than literal slash.
    const norm = r.configPath.replace(/\\/g, '/');
    expect(norm).toContain('Library/Application Support/Claude');
    expect(norm).toContain('claude_desktop_config.json');
    expect(r.format).toBe('json');
    expect(r.displayName).toBe('Claude Desktop');
    expect(r.unsupportedOs).toBeFalsy();
  });

  it('claude on win32 uses APPDATA\\Claude', () => {
    const r = resolveClientPath('claude', {
      platform: 'win32',
      homedir:  'C:\\Users\\u',
      env:      { APPDATA },
    });
    expect(r.configPath).toContain('Claude');
    expect(r.configPath).toContain('claude_desktop_config.json');
    expect(r.format).toBe('json');
  });

  it('claude on linux flagged unsupportedOs', () => {
    const r = resolveClientPath('claude', { platform: 'linux', homedir: HOME });
    expect(r.unsupportedOs).toBe(true);
  });

  it('cursor uses ~/.cursor/mcp.json on every OS', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const r = resolveClientPath('cursor', { platform, homedir: HOME });
      expect(r.configPath).toContain('.cursor');
      expect(r.configPath).toContain('mcp.json');
      expect(r.format).toBe('jsonc');
    }
  });
});
