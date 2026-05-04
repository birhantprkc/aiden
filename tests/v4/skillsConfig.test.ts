import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { SkillsConfig } from '../../core/v4/skillsConfig';
import { ConfigManager } from '../../core/v4/config';
import { resolveAidenPaths } from '../../core/v4/paths';
import { parseSkillContent, type ParsedSkill } from '../../core/v4/skillSpec';

let tmp: string;
let cfg: ConfigManager;
let skillsCfg: SkillsConfig;

const skill = (name: string, extras = ''): ParsedSkill =>
  parseSkillContent(`---
name: ${name}
description: ${name} desc
version: 1.0.0
${extras}---

body
`);

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-sc-test-'));
  const paths = resolveAidenPaths({ rootOverride: tmp });
  await fs.mkdir(path.dirname(paths.configYaml), { recursive: true });
  cfg = new ConfigManager(paths);
  await cfg.load();
  skillsCfg = new SkillsConfig(cfg);
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('SkillsConfig', () => {
  it('1. isEnabled defaults to true', () => {
    expect(skillsCfg.isEnabled(skill('a'))).toBe(true);
  });

  it('2. isEnabled honors explicit disable', async () => {
    await skillsCfg.setEnabled('a', false);
    expect(skillsCfg.isEnabled(skill('a'))).toBe(false);
  });

  it('3. isEnabled gates on platforms list', () => {
    const noisy = skill('np', `platforms: [${process.platform === 'win32' ? 'linux' : 'windows'}]\n`);
    expect(skillsCfg.isEnabled(noisy)).toBe(false);
    const matching = skill(
      'mp',
      `platforms: [${process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'}]\n`,
    );
    expect(skillsCfg.isEnabled(matching)).toBe(true);
  });

  it('4. resolveSkillConfig returns declared defaults', () => {
    const s = skill(
      'cfg',
      `metadata:
  aiden:
    config:
      - key: api_key
        default: SAMPLE_KEY
      - key: timeout
        default: "30"
`,
    );
    const r = skillsCfg.resolveSkillConfig(s);
    expect(r.api_key).toBe('SAMPLE_KEY');
    expect(r.timeout).toBe('30');
  });

  it('5. resolveSkillConfig prefers config.yaml override over default', async () => {
    cfg.set('skills.cfg.config.api_key', 'OVERRIDE');
    await cfg.save();
    const s = skill(
      'cfg',
      `metadata:
  aiden:
    config:
      - key: api_key
        default: SAMPLE_KEY
`,
    );
    const r = skillsCfg.resolveSkillConfig(s);
    expect(r.api_key).toBe('OVERRIDE');
  });

  it('6. checkRequiredEnvVars surfaces missing vars', () => {
    const original = process.env.AIDEN_PHASE10_TEST;
    delete process.env.AIDEN_PHASE10_TEST;
    const s = skill(
      'env',
      `metadata:
  aiden:
    required_environment_variables:
      - name: AIDEN_PHASE10_TEST
`,
    );
    const r = skillsCfg.checkRequiredEnvVars(s);
    expect(r.ok).toBe(false);
    expect(r.missing).toContain('AIDEN_PHASE10_TEST');
    if (original !== undefined) process.env.AIDEN_PHASE10_TEST = original;
  });
});
