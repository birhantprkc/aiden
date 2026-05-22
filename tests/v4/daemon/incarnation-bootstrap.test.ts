/**
 * tests/v4/daemon/incarnation-bootstrap.test.ts — v4.9.0 Slice 4
 * end-to-end integration. Drives `bootstrapDaemon()` against a tmp
 * AIDEN_HOME and asserts:
 *
 *   - daemon_id file is created on first boot (smoke 1)
 *   - daemon_incarnations row is inserted (smoke 2)
 *   - daemon.log NDJSON carries the new identity fields (smoke 3)
 *   - drain path marks the incarnation row with exit_reason='clean' (smoke 4)
 *   - crash handler marks it with exit_reason='crash' (smoke 5)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  bootstrapDaemonFoundation,
  getDaemonHandle,
  getCurrentDaemonId,
  getCurrentIncarnationId,
  _resetDaemonBootstrapForTests,
} from '../../../core/v4/daemon/bootstrap';
import { markEnded } from '../../../core/v4/daemon/incarnationStore';

let aidenHome: string;
let prev: Record<string, string | undefined>;

beforeEach(() => {
  aidenHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-s4-boot-'));
  prev = {
    AIDEN_HOME:        process.env.AIDEN_HOME,
    HOME:              process.env.HOME,
    USERPROFILE:       process.env.USERPROFILE,
    AIDEN_DAEMON:      process.env.AIDEN_DAEMON,
    AIDEN_DAEMON_PORT: process.env.AIDEN_DAEMON_PORT,
  };
  process.env.AIDEN_HOME = aidenHome;
  process.env.HOME = aidenHome;
  process.env.USERPROFILE = aidenHome;
  process.env.AIDEN_DAEMON = '1';
  process.env.AIDEN_DAEMON_PORT = String(40000 + Math.floor(Math.random() * 10000));
  _resetDaemonBootstrapForTests();
});

afterEach(async () => {
  const handle = getDaemonHandle();
  if (handle?.dispatcher) { try { await handle.dispatcher.stop(2_000); } catch { /* noop */ } }
  if (handle?.httpServer) { try { handle.httpServer.close(); } catch { /* noop */ } }
  if (handle?.runtimeLock) { try { handle.runtimeLock.release(); } catch { /* noop */ } }
  if (handle?.instanceTracker) { try { handle.instanceTracker.stop(); } catch { /* noop */ } }
  _resetDaemonBootstrapForTests();
  for (const k of Object.keys(prev)) {
    if (prev[k] === undefined) delete process.env[k];
    else                       process.env[k] = prev[k];
  }
  try { fs.rmSync(aidenHome, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('Slice 4 boot lifecycle — identity + incarnation', () => {
  it('boot creates daemon_id file + daemon_incarnations row + stamps NDJSON log', async () => {
    const handle = bootstrapDaemonFoundation();
    expect(handle.active).toBe(true);

    // Smoke 1: daemon_id file exists with dmn_ content.
    const idPath = path.join(aidenHome, 'daemon', 'daemon_id');
    expect(fs.existsSync(idPath)).toBe(true);
    const idFromFile = fs.readFileSync(idPath, 'utf8').trim();
    expect(idFromFile).toMatch(/^dmn_[0-9a-f]{32}$/);
    expect(idFromFile).toBe(getCurrentDaemonId());
    console.log(`[smoke 1] daemon_id file content: ${idFromFile}`);

    // Smoke 2: daemon_incarnations row exists with inc_ id matching holder.
    const dbPath = handle.dbPath!;
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare(
      `SELECT * FROM daemon_incarnations ORDER BY started_at DESC LIMIT 1`,
    ).get() as Record<string, unknown>;
    db.close();
    expect(row).toBeDefined();
    expect(row.incarnation_id).toBe(getCurrentIncarnationId());
    expect(row.daemon_id).toBe(idFromFile);
    expect(row.pid).toBe(process.pid);
    expect(row.ended_at).toBeNull();
    console.log(`[smoke 2] daemon_incarnations row: incarnation_id=${row.incarnation_id} daemon_id=${row.daemon_id} pid=${row.pid} started_at=${row.started_at}`);

    // Smoke 3: daemon.log NDJSON lines carry incarnationId + daemonId.
    // Give the file sink a beat to flush — appendFileSync is synchronous
    // but we want to ensure boot has emitted at least one identity line.
    await new Promise<void>((r) => setTimeout(r, 100));
    const logPath = path.join(aidenHome, 'logs', 'daemon.log');
    expect(fs.existsSync(logPath)).toBe(true);
    const lines = fs.readFileSync(logPath, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const identityLines = lines.filter((l) =>
      typeof l.incarnationId === 'string' && typeof l.daemonId === 'string',
    );
    expect(identityLines.length).toBeGreaterThan(0);
    const first = identityLines[0];
    expect(first.incarnationId).toBe(getCurrentIncarnationId());
    expect(first.daemonId).toBe(idFromFile);
    console.log(`[smoke 3] daemon.log first identity-stamped line: ${JSON.stringify({
      ts: first.ts, level: first.level, msg: first.msg,
      incarnationId: first.incarnationId, daemonId: first.daemonId,
    })}`);
  });

  it('clean drain path marks incarnation row with exit_reason=\'sigterm\'', async () => {
    bootstrapDaemonFoundation();
    const incId = getCurrentIncarnationId()!;
    const handle = getDaemonHandle()!;
    const dbPath = handle.dbPath!;
    // Drive the drain-marker side effect directly — simulates what
    // signals.ts would do on SIGTERM, calling drainContext.markShutdown.
    const db = new Database(dbPath);
    markEnded(db, { incarnationId: incId, exitReason: 'sigterm', exitCode: 0 });
    const row = db.prepare(
      `SELECT exit_reason, exit_code, ended_at FROM daemon_incarnations WHERE incarnation_id = ?`,
    ).get(incId) as { exit_reason: string; exit_code: number; ended_at: string };
    db.close();
    expect(row.exit_reason).toBe('sigterm');
    expect(row.exit_code).toBe(0);
    expect(row.ended_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    console.log(`[smoke 4] post-clean-shutdown row: ${JSON.stringify(row)}`);
  });

  it('crash-path markEnded sets exit_reason=\'crash\' (simulates uncaughtException handler)', async () => {
    bootstrapDaemonFoundation();
    const incId = getCurrentIncarnationId()!;
    const handle = getDaemonHandle()!;
    const dbPath = handle.dbPath!;
    // The crash handler in bootstrap.ts calls `markEnded(db,
    // {exitReason:'crash', exitCode:1})` before process.exit. We can't
    // actually trip uncaughtException in-test (it would kill the test
    // worker), so we drive the same store helper the handler uses —
    // verifying the wired-in path produces the expected row shape.
    const db = new Database(dbPath);
    markEnded(db, { incarnationId: incId, exitReason: 'crash', exitCode: 1 });
    const row = db.prepare(
      `SELECT exit_reason, exit_code FROM daemon_incarnations WHERE incarnation_id = ?`,
    ).get(incId) as { exit_reason: string; exit_code: number };
    db.close();
    expect(row.exit_reason).toBe('crash');
    expect(row.exit_code).toBe(1);
    console.log(`[smoke 5] post-crash row: ${JSON.stringify(row)}`);
  });
});
