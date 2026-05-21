/**
 * tests/v4/mcp/install/jsoncMerge.test.ts — v4.9.0 Slice 2a.
 *
 * Critical coverage: JSONC writes must preserve user comments + the
 * other mcpServers.* entries.
 */
import { describe, it, expect } from 'vitest';
import {
  mergeAidenEntry,
  readAidenEntry,
  buildAidenEntryObject,
} from '../../../../core/v4/mcp/install/jsoncMerge';

const aidenEntry = buildAidenEntryObject({
  command: 'aiden',
  args:    ['mcp', 'serve'],
});

describe('mergeAidenEntry — Slice 2a', () => {
  it('plain JSON: adds aiden + preserves other mcpServers', () => {
    const before = `{
  "mcpServers": {
    "other-server": { "command": "other", "args": ["x"] }
  }
}
`;
    const after = mergeAidenEntry(before, aidenEntry, 'json');
    const doc = JSON.parse(after) as {
      mcpServers: Record<string, { command: string }>;
    };
    expect(doc.mcpServers['other-server'].command).toBe('other');
    expect(doc.mcpServers.aiden.command).toBe('aiden');
    expect((doc.mcpServers.aiden as unknown as { _aiden: { managed: boolean } })._aiden.managed).toBe(true);
  });

  it('plain JSON: creates mcpServers when absent', () => {
    const before = '{}';
    const after = mergeAidenEntry(before, aidenEntry, 'json');
    const doc = JSON.parse(after) as { mcpServers: { aiden: unknown } };
    expect(doc.mcpServers.aiden).toBeDefined();
  });

  it('plain JSON: preserves other top-level keys (Claude Desktop has many)', () => {
    const before = `{
  "theme": "dark",
  "notifications": true,
  "mcpServers": {}
}
`;
    const after = mergeAidenEntry(before, aidenEntry, 'json');
    const doc = JSON.parse(after) as { theme: string; notifications: boolean };
    expect(doc.theme).toBe('dark');
    expect(doc.notifications).toBe(true);
  });

  it('JSONC: preserves user comments outside the touched key path', () => {
    const before = `{
  // User's notes:
  // This is my cursor MCP config.
  "mcpServers": {
    // I really like this server
    "weather": { "command": "node", "args": ["weather.js"] }
  }
}
`;
    const after = mergeAidenEntry(before, aidenEntry, 'jsonc');
    expect(after).toContain("// User's notes:");
    expect(after).toContain('// This is my cursor MCP config.');
    expect(after).toContain('// I really like this server');
    expect(after).toContain('weather');
    expect(after).toContain('aiden');
  });

  it('JSONC: handles empty file by writing a fresh skeleton', () => {
    const after = mergeAidenEntry('', aidenEntry, 'jsonc');
    expect(after).toMatch(/"aiden"/);
    expect(after).toMatch(/"mcp",\s*"serve"/);
  });

  it('JSONC: idempotent — second merge produces same content', () => {
    const before = `{
  "mcpServers": {}
}
`;
    const once = mergeAidenEntry(before, aidenEntry, 'jsonc');
    const twice = mergeAidenEntry(once, aidenEntry, 'jsonc');
    // Reading the entry should round-trip identically.
    expect(readAidenEntry(twice)?.command).toBe('aiden');
  });
});

describe('readAidenEntry — Slice 2a', () => {
  it('extracts the aiden entry from JSON', () => {
    const text = JSON.stringify({
      mcpServers: {
        aiden: { command: 'aiden', args: ['mcp', 'serve'], _aiden: { managed: true, version: 1 } },
      },
    });
    const entry = readAidenEntry(text);
    expect(entry?.command).toBe('aiden');
    expect(entry?._aiden?.managed).toBe(true);
  });

  it('returns null when entry is absent', () => {
    expect(readAidenEntry('{"mcpServers":{}}')).toBe(null);
  });

  it('returns null on malformed JSON', () => {
    expect(readAidenEntry('not json')).toBe(null);
  });
});
