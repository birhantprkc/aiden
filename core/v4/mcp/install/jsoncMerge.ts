/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/mcp/install/jsoncMerge.ts — v4.9.0 Slice 2a.
 *
 * Merge Aiden's `mcpServers.aiden` entry into a third-party client
 * config file. Two formats:
 *
 *   format: 'json'   — Claude Desktop's claude_desktop_config.json,
 *                      plain JSON. Round-trip via JSON.parse +
 *                      JSON.stringify with 2-space indent.
 *
 *   format: 'jsonc'  — Cursor's mcp.json, JSON-with-comments. Round-
 *                      tripping through JSON.parse destroys user
 *                      comments + custom formatting. We use
 *                      `jsonc-parser`'s `modify()` + `applyEdits()`
 *                      to make a surgical edit that preserves the
 *                      rest of the file verbatim.
 *
 * Either path is atomic from the caller's POV: this module returns
 * the NEW file content as a string; the caller is responsible for
 * tmp-file-then-rename.
 */

import { modify, applyEdits, parseTree, findNodeAtLocation } from 'jsonc-parser';

export interface AidenEntry {
  command: string;
  args:    string[];
  env?:    Record<string, string>;
  _aiden?: { managed: true; version: number };
}

/** Produce the canonical Aiden entry. */
export function buildAidenEntryObject(opts: {
  command: string;
  args:    string[];
  envKeys?: string[];
}): AidenEntry {
  const entry: AidenEntry = {
    command: opts.command,
    args:    opts.args,
    _aiden:  { managed: true, version: 1 },
  };
  if (opts.envKeys && opts.envKeys.length > 0) {
    entry.env = {};
    for (const k of opts.envKeys) entry.env[k] = `\${${k}}`;
  }
  return entry;
}

/**
 * Build the empty starter content for a brand-new config file. Used
 * when a client's parent dir exists but the config file doesn't.
 */
export function emptyConfig(format: 'json' | 'jsonc'): string {
  // Identical content for both formats — the difference only matters
  // for downstream merges where the user may have added comments.
  void format;
  return '{\n  "mcpServers": {}\n}\n';
}

/**
 * Merge `entry` into the existing JSON / JSONC text under
 * `mcpServers.aiden`. Returns the new text. Existing siblings under
 * `mcpServers.*` are preserved untouched; other top-level keys
 * (Claude Desktop has many) are preserved untouched.
 */
export function mergeAidenEntry(
  existingText: string,
  entry:        AidenEntry,
  format:       'json' | 'jsonc',
): string {
  if (format === 'json') {
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(existingText) as Record<string, unknown>;
    } catch {
      // Corrupt JSON — fall back to a fresh shell. Caller's backup
      // means the user can recover the original file if needed.
      doc = {};
    }
    if (typeof doc !== 'object' || doc === null) doc = {};
    const servers = (doc.mcpServers as Record<string, unknown>) ?? {};
    servers.aiden = entry as unknown as Record<string, unknown>;
    doc.mcpServers = servers;
    return JSON.stringify(doc, null, 2) + '\n';
  }

  // JSONC path: use modify() to produce a minimal edit that preserves
  // comments + formatting outside the touched key path.
  const formatOpts = { tabSize: 2, insertSpaces: true };
  const path = ['mcpServers', 'aiden'];

  // If the file is empty or doesn't have mcpServers yet, prepare a
  // skeleton first via plain JSON.parse-and-stringify. Once
  // mcpServers exists, modify() handles the surgical edit cleanly.
  const tree = parseTree(existingText);
  const root = tree;
  let text = existingText;
  if (!root || root.type !== 'object') {
    text = emptyConfig('jsonc');
  } else {
    const mcpNode = findNodeAtLocation(root, ['mcpServers']);
    if (!mcpNode || mcpNode.type !== 'object') {
      const edits = modify(text, ['mcpServers'], {}, { formattingOptions: formatOpts });
      text = applyEdits(text, edits);
    }
  }
  const edits = modify(text, path, entry as unknown as Record<string, unknown>, {
    formattingOptions: formatOpts,
  });
  return applyEdits(text, edits);
}

/**
 * Read the current Aiden entry (or null when absent) from text.
 * Tolerates both formats; jsonc-parser handles plain JSON too.
 */
export function readAidenEntry(existingText: string): AidenEntry | null {
  const tree = parseTree(existingText);
  if (!tree) return null;
  const node = findNodeAtLocation(tree, ['mcpServers', 'aiden']);
  if (!node) return null;
  try {
    // jsonc-parser parses the node's slice; safe even with comments
    // sprinkled inside the object.
    const segment = existingText.slice(node.offset, node.offset + node.length);
    return JSON.parse(segment) as AidenEntry;
  } catch {
    return null;
  }
}
