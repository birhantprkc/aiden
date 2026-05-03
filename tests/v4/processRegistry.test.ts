import { describe, it, expect, afterEach } from 'vitest';
import { ProcessRegistry } from '../../core/v4/processRegistry';

const isWin = process.platform === 'win32';
const echoCmd = (msg: string) =>
  isWin ? `Write-Output '${msg}'` : `echo '${msg}'`;
const sleepCmd = (sec: number) =>
  isWin
    ? `Start-Sleep -Seconds ${sec}; Write-Output done`
    : `sleep ${sec} && echo done`;

let registries: ProcessRegistry[] = [];
const make = (): ProcessRegistry => {
  const r = new ProcessRegistry();
  registries.push(r);
  return r;
};

afterEach(() => {
  for (const r of registries) r.cleanup();
  registries = [];
});

describe('ProcessRegistry', () => {
  it('1. spawn returns a valid handle', () => {
    const r = make();
    const h = r.spawn(echoCmd('hi'));
    expect(h.id).toMatch(/[0-9a-f-]{8,}/);
    expect(h.command).toContain('hi');
    expect(h.status).toBe('running');
    expect(typeof h.pid).toBe('number');
  });

  it('2. list shows running processes', () => {
    const r = make();
    const a = r.spawn(sleepCmd(2));
    const b = r.spawn(sleepCmd(2));
    const ids = r.list().map((h) => h.id).sort();
    expect(ids).toEqual([a.id, b.id].sort());
  });

  it('3. readLog returns captured output after exit', async () => {
    const r = make();
    const h = r.spawn(echoCmd('hello-from-proc'));
    await r.waitFor(h.id, 10_000);
    const log = r.readLog(h.id, 100);
    expect(log.join('\n')).toMatch(/hello-from-proc/);
  });

  it('4. kill terminates a running process', async () => {
    const r = make();
    const h = r.spawn(sleepCmd(30));
    expect(h.status).toBe('running');
    const ok = r.kill(h.id);
    expect(ok).toBe(true);
    const final = await r.waitFor(h.id, 5000);
    expect(final.status === 'killed' || final.status === 'exited').toBe(true);
  });

  it('5. waitFor resolves on natural exit', async () => {
    const r = make();
    const h = r.spawn(echoCmd('done-natural'));
    const final = await r.waitFor(h.id, 10_000);
    expect(final.status).toBe('exited');
    expect(final.exitedAt).toBeGreaterThan(0);
  });

  it('6. waitFor resolves on kill', async () => {
    const r = make();
    const h = r.spawn(sleepCmd(30));
    setTimeout(() => r.kill(h.id), 100);
    const final = await r.waitFor(h.id, 5000);
    expect(final.status === 'killed' || final.status === 'exited').toBe(true);
  });

  it('7. waitFor times out cleanly', async () => {
    const r = make();
    const h = r.spawn(sleepCmd(30));
    await expect(r.waitFor(h.id, 100)).rejects.toThrow(/timeout/i);
    r.kill(h.id);
  });

  it('8. get returns null for unknown id', () => {
    const r = make();
    expect(r.get('does-not-exist')).toBeNull();
  });

  it('9. cleanup kills all running', async () => {
    const r = make();
    const a = r.spawn(sleepCmd(30));
    const b = r.spawn(sleepCmd(30));
    r.cleanup();
    expect(r.get(a.id)?.status).toBe('killed');
    expect(r.get(b.id)?.status).toBe('killed');
  });

  it("10. multiple concurrent processes don't bleed logs", async () => {
    const r = make();
    const a = r.spawn(echoCmd('aaa-marker'));
    const b = r.spawn(echoCmd('bbb-marker'));
    await Promise.all([r.waitFor(a.id, 10_000), r.waitFor(b.id, 10_000)]);
    const logA = r.readLog(a.id).join('\n');
    const logB = r.readLog(b.id).join('\n');
    expect(logA).toMatch(/aaa-marker/);
    expect(logA).not.toMatch(/bbb-marker/);
    expect(logB).toMatch(/bbb-marker/);
    expect(logB).not.toMatch(/aaa-marker/);
  });
});
