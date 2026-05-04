/**
 * Phase 16a smoke gate — exercises /personality, /skin, /skin reload,
 * /reasoning through the real CommandRegistry + Display in a real
 * PowerShell process. Does not touch a provider or LLM.
 *
 * Run:  npx tsx scripts/smoke-phase16a.ts
 *
 * Exits 0 on success, non-zero on first failure.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CommandRegistry } from '../cli/v4/commandRegistry';
import { Display } from '../cli/v4/display';
import { SkinEngine } from '../cli/v4/skinEngine';
import { allCommands } from '../cli/v4/commands';
import { PersonalityManager } from '../core/v4/personality';
import { resolveAidenPaths } from '../core/v4/paths';
import { ConfigManager } from '../core/v4/config';

function fail(msg: string): never {
  console.error(`\nSMOKE FAIL: ${msg}`);
  process.exit(1);
}

function expect(cond: boolean, msg: string): void {
  if (!cond) fail(msg);
}

async function main(): Promise<void> {
  console.log('Phase 16a smoke gate starting…\n');

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-16a-smoke-'));
  process.env.AIDEN_HOME = tmpRoot;
  const paths = resolveAidenPaths({ rootOverride: tmpRoot });
  await fs.mkdir(paths.skinsDir, { recursive: true });
  await fs.mkdir(paths.personalitiesDir, { recursive: true });

  const skin = new SkinEngine({ forceMono: true });
  await skin.discover();
  const display = new Display({ skin, stdout: process.stdout });
  const registry = new CommandRegistry();
  for (const cmd of allCommands) registry.register(cmd);

  const personalityManager = new PersonalityManager({ paths });

  // 1. /personality (bare): list bundled personalities.
  console.log('--- /personality ---');
  await registry.execute('/personality', {
    display,
    personalityManager,
    config: new ConfigManager(paths),
  });

  // 2. /personality concise: switch.
  console.log('\n--- /personality concise ---');
  await registry.execute('/personality concise', {
    display,
    personalityManager,
    config: new ConfigManager(paths),
  });
  expect(personalityManager.getCurrent() === 'concise', '/personality concise did not switch');

  // 3. /personality unknown: graceful error.
  console.log('\n--- /personality ghost ---');
  await registry.execute('/personality ghost', {
    display,
    personalityManager,
    config: new ConfigManager(paths),
  });
  expect(personalityManager.getCurrent() === 'concise', 'ghost should not have switched');

  // 4. /skin (bare): list available skins.
  console.log('\n--- /skin ---');
  await registry.execute('/skin', {
    display,
    skin,
    config: new ConfigManager(paths),
  });

  // 5. /skin monochrome: switch to bundled.
  console.log('\n--- /skin monochrome ---');
  await registry.execute('/skin monochrome', {
    display,
    skin,
    config: new ConfigManager(paths),
  });
  expect(skin.getActive().name === 'monochrome', '/skin monochrome did not switch');

  // 6. /skin light: switch to a different bundled skin.
  console.log('\n--- /skin light ---');
  await registry.execute('/skin light', {
    display,
    skin,
    config: new ConfigManager(paths),
  });
  expect(skin.getActive().name === 'light', '/skin light did not switch');

  // 7. /skin reload: should re-read disk for active skin.
  console.log('\n--- /skin reload ---');
  await registry.execute('/skin reload', {
    display,
    skin,
    config: new ConfigManager(paths),
  });

  // 8. /reasoning (bare): show current.
  console.log('\n--- /reasoning ---');
  const cfg = new ConfigManager(paths);
  await registry.execute('/reasoning', {
    display,
    config: cfg,
  });

  // 9. /reasoning high: persist.
  console.log('\n--- /reasoning high ---');
  await registry.execute('/reasoning high', {
    display,
    config: cfg,
  });
  expect(
    cfg.getValue<string>('agent.reasoning_effort') === 'high',
    '/reasoning high did not persist',
  );

  // 10. /reasoning bogus: graceful error.
  console.log('\n--- /reasoning extreme ---');
  await registry.execute('/reasoning extreme', {
    display,
    config: cfg,
  });
  expect(
    cfg.getValue<string>('agent.reasoning_effort') === 'high',
    'invalid /reasoning value should not have overwritten',
  );

  // 11. Recent commands sanity check.
  const recent = registry.serializeRecent();
  expect(recent.length > 0, 'serializeRecent returned empty after invocations');
  expect(recent[0] === 'reasoning', `expected most-recent to be 'reasoning', got '${recent[0]}'`);

  await fs.rm(tmpRoot, { recursive: true, force: true });
  console.log('\nSMOKE PASS — all four commands functional.');
}

main().catch((err) => {
  console.error('\nSMOKE FAIL: unexpected exception:', err);
  process.exit(1);
});
