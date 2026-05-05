import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Phase 20 Task 4 — protect the npm publish surface from accidental drift.
 * If anyone bumps `version` to something unexpected, drops `publishConfig`,
 * or removes `prepublishOnly` we want a screaming red test before a tag
 * push fires the GitHub workflow.
 */
describe('npm publish config', () => {
  it('1. package.json declares version 4.0.0-beta.* and public publishConfig', async () => {
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const raw = await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as Record<string, any>;
    expect(pkg.name).toBe('aiden-runtime');
    expect(pkg.version).toMatch(/^4\.0\.0(-beta\.\d+)?$/);
    expect(pkg.publishConfig?.access).toBe('public');
    expect(pkg.scripts?.prepublishOnly).toContain('typecheck');
    expect(pkg.scripts?.prepublishOnly).toContain('test');
    expect(pkg.scripts?.['publish:beta']).toBeDefined();
    expect(pkg.scripts?.['publish:stable']).toBeDefined();
  });

  it('2. publish workflow exists and gates on tag pattern v4.*', async () => {
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const wf = await fs.readFile(
      path.join(repoRoot, '.github', 'workflows', 'publish.yml'),
      'utf8',
    );
    expect(wf).toContain('v4.*.*-beta.*');
    expect(wf).toContain('v4.*.*');
    expect(wf).toContain('NPM_TOKEN');
    expect(wf).toContain('npm publish');
    // Verifies the version-vs-tag guard so "v4.0.0-beta.1 tag with package.json
    // still at 3.19.9" can never publish.
    expect(wf).toContain('Verified: tag and package.json');
  });
});
