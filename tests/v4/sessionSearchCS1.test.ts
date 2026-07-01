/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12 CS.1 — search quality + migration substrate:
 *   - tool_name / tool_calls indexed alongside content (intent recall)
 *   - role filter (user+assistant default; tool output opt-in)
 *   - ordering (BM25 default, newest/oldest)
 *   - ★ the user_version migration: an existing content-only FTS DB is rebuilt so
 *     PRE-EXISTING messages become findable by their tool_calls (reindex, not
 *     just new-message indexing); version bumps; idempotent re-run.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

import { SessionStore } from '../../core/v4/sessionStore';

let tmpDir: string;
let dbPath: string;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-cs1-'));
  dbPath = path.join(tmpDir, 'sessions.db');
});
afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

describe('CS.1 — tool_calls indexed for recall', () => {
  it('a session is findable by a tool name / command in a tool_call NOT present in content', () => {
    const store = new SessionStore(dbPath);
    const s = store.createSession({ title: 't' });
    store.appendMessage(s.id, {
      role: 'assistant',
      content: 'running that for you', // note: no "zzqux", no "shell_exec" in prose
      toolCalls: [{ id: 'c1', name: 'shell_exec', arguments: { command: 'grep zzqux ./src' } }],
    });
    // term only present inside the serialized tool_call:
    expect(store.search('zzqux').some((r) => r.sessionId === s.id)).toBe(true);
    expect(store.search('shell_exec').some((r) => r.sessionId === s.id)).toBe(true);
    store.close();
  });
});

describe('CS.1 — role filter (default user+assistant; tool opt-in)', () => {
  it('default search excludes tool-OUTPUT; include_tool_output includes it', () => {
    const store = new SessionStore(dbPath);
    const s = store.createSession({ title: 'roles' });
    store.appendMessage(s.id, { role: 'user', content: 'apricot please' });
    store.appendMessage(s.id, { role: 'assistant', content: 'apricot incoming' });
    store.appendMessage(s.id, { role: 'tool', content: 'apricot banana toolnoise', toolCallId: 'c1' });

    const def = store.search('apricot');
    expect(def.length).toBe(2);                        // user + assistant only
    const withTool = store.search('apricot', { includeToolOutput: true });
    expect(withTool.length).toBe(3);                   // + tool output
    // a term only in tool OUTPUT: invisible by default, visible opt-in
    expect(store.search('banana').length).toBe(0);
    expect(store.search('banana', { includeToolOutput: true }).length).toBe(1);
    store.close();
  });
});

describe('CS.1 — ordering', () => {
  it('newest/oldest order by message time; relevance is the default', async () => {
    const store = new SessionStore(dbPath);
    const s = store.createSession({ title: 'order' });
    store.appendMessage(s.id, { role: 'user', content: 'orderterm first' }); await sleep(6);
    store.appendMessage(s.id, { role: 'user', content: 'orderterm second' }); await sleep(6);
    store.appendMessage(s.id, { role: 'user', content: 'orderterm third' });

    const newest = store.search('orderterm', { order: 'newest' });
    const oldest = store.search('orderterm', { order: 'oldest' });
    expect(newest.length).toBe(3);
    expect(newest[0].matchedAt).toBeGreaterThan(oldest[0].matchedAt); // distinct, opposite ends
    expect(newest[0].matchedAt).toBe(Math.max(...newest.map((r) => r.matchedAt)));
    expect(oldest[0].matchedAt).toBe(Math.min(...oldest.map((r) => r.matchedAt)));
    expect(store.search('orderterm').length).toBe(3);                  // relevance default works
    store.close();
  });
});

describe('CS.1 — ★ migration / reindex of an existing content-only DB', () => {
  // Build a pre-CS.1 DB: content-only FTS + content-only triggers + user_version 0,
  // with a message whose search term lives ONLY in tool_calls (not content).
  function seedLegacyDb(p: string): void {
    const db = new Database(p);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, provider_id TEXT, model_id TEXT,
        total_input_tokens INTEGER NOT NULL DEFAULT 0, total_output_tokens INTEGER NOT NULL DEFAULT 0,
        metadata TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL, content TEXT NOT NULL, tool_calls TEXT, tool_call_id TEXT,
        created_at INTEGER NOT NULL, turn_number INTEGER);
      CREATE VIRTUAL TABLE messages_fts USING fts5(content, session_id UNINDEXED, message_id UNINDEXED);
      CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content, session_id, message_id) VALUES (new.id, new.content, new.session_id, new.id);
      END;
    `);
    const now = Date.now();
    db.prepare('INSERT INTO sessions (id,title,created_at,updated_at) VALUES (?,?,?,?)').run('sess-legacy', 'legacy', now, now);
    db.prepare('INSERT INTO messages (session_id,role,content,tool_calls,created_at) VALUES (?,?,?,?,?)')
      .run('sess-legacy', 'assistant', 'did the thing',
        JSON.stringify([{ id: 'c1', name: 'shell_exec', arguments: { command: 'deploy legacytoken123' } }]), now);
    // user_version stays 0 (legacy). Confirm legacy FTS canNOT find the tool_call term:
    const pre = db.prepare("SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'legacytoken123'").get() as { n: number };
    expect(pre.n).toBe(0); // content-only index → invisible before migration
    db.close();
  }

  it('migration reindexes the EXISTING corpus so pre-stored tool_calls become findable', () => {
    seedLegacyDb(dbPath);
    const store = new SessionStore(dbPath); // constructor runs migrate() → reindex
    const hits = store.search('legacytoken123');
    expect(hits.length).toBe(1);                       // the PRE-EXISTING message, now findable
    expect(hits[0].sessionId).toBe('sess-legacy');
    store.close();
  });

  it('user_version is bumped to the current schema version', () => {
    seedLegacyDb(dbPath);
    const store = new SessionStore(dbPath); store.close();
    const db = new Database(dbPath);
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    db.close();
  });

  it('migration is idempotent — re-open does not double-index', () => {
    const store1 = new SessionStore(dbPath);
    const s = store1.createSession({ title: 'idem' });
    store1.appendMessage(s.id, { role: 'user', content: 'uniquetermidem' });
    expect(store1.search('uniquetermidem').length).toBe(1);
    store1.close();
    // reopen → migrate() sees version already current → no rebuild, no duplicate rows
    const store2 = new SessionStore(dbPath);
    expect(store2.search('uniquetermidem').length).toBe(1);
    store2.close();
  });
});
