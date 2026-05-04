/**
 * Phase 16b smoke gate — confirms `buildAgentRuntime` constructs all 6
 * moat layers and attaches them to the AidenAgent.
 *
 * Implementation: invokes the unit-test file (which uses vi.mock to
 * stub the provider resolver) via vitest in a child process. We treat
 * a clean test pass as the smoke pass — if the wiring drops, the unit
 * test fails and we exit non-zero.
 *
 * Run:  npx tsx scripts/smoke-phase16b.ts
 *
 * Exits 0 on success, non-zero on first failure.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

function fail(msg: string): never {
  console.error(`\nSMOKE FAIL: ${msg}`);
  process.exit(1);
}

function main(): void {
  console.log('Phase 16b smoke gate starting…\n');

  const repoRoot = path.resolve(__dirname, '..');
  const target = 'tests/v4/cli/aidenCLI.moatBoot.test.ts';
  const result = spawnSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs'),
      'run',
      target,
    ],
    {
      cwd: repoRoot,
      stdio: 'inherit',
      env: { ...process.env, FORCE_COLOR: '0' },
    },
  );
  if (result.status !== 0) {
    fail(`moat boot test exited with code ${result.status}`);
  }

  // A second, manual sanity assertion: import the buildAgentRuntime
  // symbol so we fail fast if the export ever disappears.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('../cli/v4/aidenCLI');
  if (typeof mod.buildAgentRuntime !== 'function') {
    fail('buildAgentRuntime export missing from cli/v4/aidenCLI');
  }

  console.log(
    '\nSMOKE PASS — Phase 16b moat-boot test green; buildAgentRuntime exported.',
  );
}

main();
