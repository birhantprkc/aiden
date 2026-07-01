/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/mcpImport.ts — v4.12 Slice 1c
 *
 * Pure mapper: standard Claude-Desktop/Cursor MCP config → Aiden's
 * `mcp.servers.<name>` shape. No I/O — the caller (`/mcp import`) owns the
 * file read, collision filtering, confirm gate, and live connect.
 *
 * Standard format:
 *   { "mcpServers": {
 *       "filesystem": { "command": "npx", "args": ["-y", "@…/server-filesystem", "/p"] },
 *       "git":        { "command": "uvx", "args": ["mcp-server-git"], "env": { "K": "v" } },
 *       "hosted":     { "url": "https://example.com/mcp" }
 *   } }
 *
 * Mapping:
 *   - `command` (+ optional `args`, `env`) → { type:'stdio', stdio:{command,args,env?} }
 *   - `url` (no command)                   → { type:'http',  http:{baseUrl} }
 *   - neither / not an object              → skipped, with a reason
 *
 * Import is the ONE path where `env` is accepted: it comes from a file, not
 * typed into REPL scrollback, so the secrets-in-scrollback concern (which
 * gated env out of `/mcp add`) does not apply.
 */

export type MappedEntry =
  | { type: 'stdio'; stdio: { command: string; args: string[]; env?: Record<string, string> } }
  | { type: 'http'; http: { baseUrl: string } };

export interface MappedServer {
  name: string;
  entry: MappedEntry;
  /** Human-readable one-liner for the confirm display. */
  cmdLine: string;
}

export interface SkippedServer {
  name: string;
  reason: string;
}

export interface MapResult {
  servers: MappedServer[];
  skipped: SkippedServer[];
  /** False when the input has no usable `mcpServers` object at all. */
  hadMcpServersKey: boolean;
}

function normalizeEnv(env: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v != null && typeof v !== 'object') out[k] = String(v);
  }
  return out;
}

/**
 * Map a parsed standard MCP config object into Aiden server entries.
 * Pure + total: never throws — malformed entries are reported in `skipped`,
 * and a missing/invalid `mcpServers` yields `hadMcpServersKey: false`.
 */
export function mapStandardMcpServers(parsed: unknown): MapResult {
  const result: MapResult = { servers: [], skipped: [], hadMcpServersKey: false };
  if (!parsed || typeof parsed !== 'object') return result;

  const ms = (parsed as Record<string, unknown>).mcpServers;
  if (!ms || typeof ms !== 'object' || Array.isArray(ms)) return result;
  result.hadMcpServersKey = true;

  for (const [name, raw] of Object.entries(ms as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      result.skipped.push({ name, reason: 'not an object' });
      continue;
    }
    const e = raw as Record<string, unknown>;

    if (typeof e.command === 'string' && e.command.length > 0) {
      const args = Array.isArray(e.args) ? e.args.map((a) => String(a)) : [];
      const stdio: { command: string; args: string[]; env?: Record<string, string> } = {
        command: e.command,
        args,
      };
      if (e.env && typeof e.env === 'object' && !Array.isArray(e.env)) {
        const env = normalizeEnv(e.env as Record<string, unknown>);
        if (Object.keys(env).length > 0) stdio.env = env;
      }
      result.servers.push({
        name,
        entry: { type: 'stdio', stdio },
        cmdLine: [e.command, ...args].join(' '),
      });
    } else if (typeof e.url === 'string' && e.url.length > 0) {
      result.servers.push({
        name,
        entry: { type: 'http', http: { baseUrl: e.url } },
        cmdLine: `(http) ${e.url}`,
      });
    } else {
      result.skipped.push({ name, reason: 'no "command" or "url"' });
    }
  }

  return result;
}
