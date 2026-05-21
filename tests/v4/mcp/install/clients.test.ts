/**
 * tests/v4/mcp/install/clients.test.ts — v4.9.0 Slice 2a.
 *
 * End-to-end install flow against a tmp dir overriding the resolved
 * client path. Covers happy path, idempotency, sibling preservation,
 * and parent-dir-missing graceful failure.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  installClient,
  planInstall,
  readClient,
} from '../../../../core/v4/mcp/install/clients';

const ENTRY_OPTS = { command: 'aiden', args: ['mcp', 'serve'] };

function tmp(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'aiden-mcp-client-'));
}

function makeOverride(dir: string, format: 'json' | 'jsonc' = 'json') {
  const configPath = path.join(dir, format === 'jsonc' ? 'mcp.json' : 'claude_desktop_config.json');
  return {
    configPath,
    parentDir:   dir,
    displayName: 'Test Client',
    format,
  };
}

describe('installClient — Slice 2a', () => {
  let dir: string;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } });

  it('writes Aiden entry on first install (plain JSON)', () => {
    const override = makeOverride(dir, 'json');
    const result = installClient('claude', { ...ENTRY_OPTS, pathOverride: override });
    expect(result.outcome).toBe('written');
    expect(existsSync(override.configPath)).toBe(true);
    const doc = JSON.parse(readFileSync(override.configPath, 'utf8')) as {
      mcpServers: { aiden: { command: string } };
    };
    expect(doc.mcpServers.aiden.command).toBe('aiden');
    // No backup on first install (source didn't exist).
    expect(result.backupPath).toBe(null);
  });

  it('idempotent — second install is a noop with no backup', () => {
    const override = makeOverride(dir, 'json');
    installClient('claude', { ...ENTRY_OPTS, pathOverride: override });
    const second = installClient('claude', { ...ENTRY_OPTS, pathOverride: override });
    expect(second.outcome).toBe('noop');
    expect(second.backupPath).toBe(null);
  });

  it('creates backup when overwriting an existing different config', () => {
    const override = makeOverride(dir, 'json');
    writeFileSync(
      override.configPath,
      JSON.stringify({ mcpServers: { aiden: { command: 'stale', args: [] } } }, null, 2),
      'utf8',
    );
    const result = installClient('claude', { ...ENTRY_OPTS, pathOverride: override });
    expect(result.outcome).toBe('written');
    expect(result.backupPath).not.toBe(null);
    expect(existsSync(result.backupPath!)).toBe(true);
  });

  it('preserves other mcpServers entries (sibling preservation)', () => {
    const override = makeOverride(dir, 'json');
    writeFileSync(
      override.configPath,
      JSON.stringify({
        mcpServers: { 'user-server': { command: 'their-cmd', args: ['x'] } },
      }, null, 2),
      'utf8',
    );
    installClient('claude', { ...ENTRY_OPTS, pathOverride: override });
    const doc = JSON.parse(readFileSync(override.configPath, 'utf8')) as {
      mcpServers: Record<string, { command: string }>;
    };
    expect(doc.mcpServers['user-server'].command).toBe('their-cmd');
    expect(doc.mcpServers.aiden.command).toBe('aiden');
  });

  it('JSONC mode preserves user comments', () => {
    const override = makeOverride(dir, 'jsonc');
    writeFileSync(
      override.configPath,
      `{
  // My custom servers
  "mcpServers": {
    "myServer": { "command": "node", "args": ["x.js"] }
  }
}
`,
      'utf8',
    );
    installClient('cursor', { ...ENTRY_OPTS, pathOverride: override });
    const after = readFileSync(override.configPath, 'utf8');
    expect(after).toContain('// My custom servers');
    expect(after).toContain('myServer');
    expect(after).toContain('aiden');
  });

  it('returns error when parent dir missing (client not installed)', () => {
    const nonexistent = path.join(dir, 'nonexistent-app');
    const override = makeOverride(nonexistent, 'json');
    const result = installClient('claude', { ...ENTRY_OPTS, pathOverride: override });
    expect(result.outcome).toBe('error');
    expect(result.error).toMatch(/not installed/);
  });

  it('planInstall produces newText without writing', () => {
    const override = makeOverride(dir, 'json');
    const planned = planInstall('claude', { ...ENTRY_OPTS, pathOverride: override });
    expect(planned).not.toBe(null);
    expect(planned!.newText).toContain('aiden');
    // File still doesn't exist.
    expect(existsSync(override.configPath)).toBe(false);
  });

  it('readClient detects absent entry, present entry, and missing file', () => {
    const override = makeOverride(dir, 'json');
    // Missing file.
    expect(readClient('claude', override).exists).toBe(false);
    // File exists, no entry.
    writeFileSync(override.configPath, '{"mcpServers":{}}', 'utf8');
    const r1 = readClient('claude', override);
    expect(r1.exists).toBe(true);
    expect(r1.entry).toBe(null);
    // Entry present.
    installClient('claude', { ...ENTRY_OPTS, pathOverride: override });
    const r2 = readClient('claude', override);
    expect(r2.entry?.command).toBe('aiden');
  });

  it('no tmp file is left behind on a clean write', () => {
    const override = makeOverride(dir, 'json');
    installClient('claude', { ...ENTRY_OPTS, pathOverride: override });
    const stragglers = readdirSync(dir).filter((f) => f.includes('.tmp-'));
    expect(stragglers).toEqual([]);
  });
});
