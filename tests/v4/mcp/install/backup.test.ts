/**
 * tests/v4/mcp/install/backup.test.ts — v4.9.0 Slice 2a.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { backupConfig, countBackups, findLatestBackup } from '../../../../core/v4/mcp/install/backup';

describe('backup — Slice 2a', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'aiden-backup-')); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } });

  it('backupConfig returns null when source does not exist', () => {
    expect(backupConfig(path.join(dir, 'missing.json'))).toBe(null);
  });

  it('backupConfig copies the file with timestamp suffix', () => {
    const src = path.join(dir, 'config.json');
    writeFileSync(src, '{"original":true}', 'utf8');
    const bk = backupConfig(src, new Date('2026-05-21T15:30:45'));
    expect(bk).not.toBe(null);
    expect(bk!).toMatch(/config\.json\.aiden-backup-20260521-153045$/);
    expect(existsSync(bk!)).toBe(true);
    expect(readFileSync(bk!, 'utf8')).toBe('{"original":true}');
  });

  it('countBackups counts only aiden-backup files', () => {
    const src = path.join(dir, 'config.json');
    writeFileSync(src, 'x', 'utf8');
    writeFileSync(`${src}.aiden-backup-20260101-000000`, 'a', 'utf8');
    writeFileSync(`${src}.aiden-backup-20260102-000000`, 'b', 'utf8');
    writeFileSync(`${src}.other-tool-backup`, 'c', 'utf8');
    expect(countBackups(src)).toBe(2);
  });

  it('findLatestBackup returns newest by timestamp', () => {
    const src = path.join(dir, 'config.json');
    writeFileSync(src, 'x', 'utf8');
    writeFileSync(`${src}.aiden-backup-20260101-000000`, 'old', 'utf8');
    writeFileSync(`${src}.aiden-backup-20260102-000000`, 'newer', 'utf8');
    writeFileSync(`${src}.aiden-backup-20260103-000000`, 'newest', 'utf8');
    const latest = findLatestBackup(src);
    expect(latest).toMatch(/20260103/);
    expect(readFileSync(latest!, 'utf8')).toBe('newest');
  });

  it('findLatestBackup returns null when none exist', () => {
    const src = path.join(dir, 'config.json');
    writeFileSync(src, 'x', 'utf8');
    expect(findLatestBackup(src)).toBe(null);
  });
});
