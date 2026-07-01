/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/mcpCatalog.ts — v4.12 Slice 4
 *
 * A CURATED, STATIC catalog of MCP servers shipped in-repo — deliberately NOT a
 * live registry (supply-chain/trust, offline, local-first). It is display +
 * pre-fill only: `/mcp catalog add <slug>` funnels through the SAME `/mcp add`
 * confirm gate (see mcpManage.ts::addServer) and never bypasses it.
 *
 * Entries are official MCP servers that work today. stdio/no-auth ones connect
 * immediately; the OAuth/streamable one (GitHub remote) is usable via the
 * 3a–3c arc: `/mcp catalog add github` → `/mcp auth github` → ready.
 */

export type CatalogTransport = 'stdio' | 'streamable' | 'sse';
export type CatalogAuth = 'none' | 'oauth';

export interface CatalogEntry {
  /** Stable, slug-friendly key + default server name. */
  slug: string;
  name: string;
  description: string;
  transport: CatalogTransport;
  auth: CatalogAuth;
  /** stdio: the launcher command (e.g. 'npx' / 'uvx'). */
  command?: string;
  /** stdio: base args; user trailing args (e.g. a path) are appended on add. */
  args?: string[];
  /** http (streamable/sse): the single endpoint URL. */
  baseUrl?: string;
  /** Where the server comes from — shown so the user can vet it. */
  sourceUrl: string;
  /** Trust / footgun notes shown before the confirm gate. */
  securityNotes: string;
}

/**
 * The seed. Official servers only; uvx entries call out the `uv` (Python)
 * dependency so a missing toolchain fails legibly. Hosted URLs are pinned only
 * when verified (GitHub) — volatile ones are omitted rather than ship stale.
 */
export const MCP_CATALOG: readonly CatalogEntry[] = [
  {
    slug: 'filesystem',
    name: 'Filesystem',
    description: 'Read/write files under a directory you choose.',
    transport: 'stdio',
    auth: 'none',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
    sourceUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    securityNotes: 'Append a directory path: `/mcp catalog add filesystem <dir>`. Full read/write to that dir — scope it narrowly.',
  },
  {
    slug: 'memory',
    name: 'Memory',
    description: 'Knowledge-graph persistent memory.',
    transport: 'stdio',
    auth: 'none',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    sourceUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
    securityNotes: 'No arguments. Stores data locally.',
  },
  {
    slug: 'sequentialthinking',
    name: 'Sequential Thinking',
    description: 'Structured, reflective multi-step reasoning.',
    transport: 'stdio',
    auth: 'none',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    sourceUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
    securityNotes: 'No arguments. Pure reasoning tool, no I/O.',
  },
  {
    slug: 'everything',
    name: 'Everything (reference)',
    description: 'Reference/test server exercising all MCP features.',
    transport: 'stdio',
    auth: 'none',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-everything'],
    sourceUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/everything',
    securityNotes: 'No arguments. Demo server — for trying MCP, not production.',
  },
  {
    slug: 'git',
    name: 'Git',
    description: 'Read, search, and manipulate Git repositories.',
    transport: 'stdio',
    auth: 'none',
    command: 'uvx',
    args: ['mcp-server-git'],
    sourceUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/git',
    securityNotes: 'Requires `uv` (Python). Append `--repository <path>`; can modify the repo.',
  },
  {
    slug: 'time',
    name: 'Time',
    description: 'Current time and timezone conversion.',
    transport: 'stdio',
    auth: 'none',
    command: 'uvx',
    args: ['mcp-server-time'],
    sourceUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/time',
    securityNotes: 'Requires `uv` (Python). No arguments.',
  },
  {
    slug: 'fetch',
    name: 'Fetch',
    description: 'Fetch a URL and convert it to markdown.',
    transport: 'stdio',
    auth: 'none',
    command: 'uvx',
    args: ['mcp-server-fetch'],
    sourceUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
    securityNotes: 'Requires `uv` (Python). Fetches arbitrary URLs the model picks — SSRF surface; avoid on hosts with sensitive internal endpoints.',
  },
  {
    slug: 'sqlite',
    name: 'SQLite',
    description: 'Query and inspect a SQLite database.',
    transport: 'stdio',
    auth: 'none',
    command: 'uvx',
    args: ['mcp-server-sqlite'],
    sourceUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite',
    securityNotes: 'Requires `uv` (Python). Append `--db-path <file>`; can read/modify that database.',
  },
  {
    slug: 'github',
    name: 'GitHub (remote)',
    description: 'GitHub repos, issues, PRs via the official remote server.',
    transport: 'streamable',
    auth: 'oauth',
    baseUrl: 'https://api.githubcopilot.com/mcp/',
    sourceUrl: 'https://github.com/github/github-mcp-server',
    securityNotes: 'Browser OAuth (no PAT). Grants access to your GitHub per the scopes you approve. After adding, run `/mcp auth github`.',
  },
] as const;

/** Look up a catalog entry by slug (case-insensitive). */
export function findCatalogEntry(slug: string): CatalogEntry | undefined {
  const s = slug.toLowerCase();
  return MCP_CATALOG.find((e) => e.slug === s);
}

/** Raw `mcp.servers.<name>` config from a catalog entry (+ user trailing args for stdio). */
export function catalogEntryToRawConfig(
  entry: CatalogEntry,
  extraArgs: string[] = [],
):
  | { type: 'stdio'; stdio: { command: string; args: string[] } }
  | { type: 'http'; http: { baseUrl: string; transport: 'streamable' | 'sse' } } {
  if (entry.transport === 'stdio') {
    if (!entry.command) throw new Error(`Catalog entry '${entry.slug}' is stdio but has no command`);
    return { type: 'stdio', stdio: { command: entry.command, args: [...(entry.args ?? []), ...extraArgs] } };
  }
  if (!entry.baseUrl) throw new Error(`Catalog entry '${entry.slug}' is ${entry.transport} but has no baseUrl`);
  return { type: 'http', http: { baseUrl: entry.baseUrl, transport: entry.transport === 'sse' ? 'sse' : 'streamable' } };
}
