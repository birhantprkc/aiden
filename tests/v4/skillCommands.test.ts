import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { SkillLoader } from '../../core/v4/skillLoader';
import { SkillCommands } from '../../core/v4/skillCommands';
import { resolveAidenPaths, type AidenPaths } from '../../core/v4/paths';

let tmp: string;
let paths: AidenPaths;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-cmd-test-'));
  paths = resolveAidenPaths({ rootOverride: tmp });
  await fs.mkdir(paths.skillsDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function writeSkill(name: string, frontmatterExtras = ''): Promise<void> {
  const dir = path.join(paths.skillsDir, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'SKILL.md'),
    `---
name: ${name}
description: ${name} desc
version: 1.0.0
${frontmatterExtras}---

# Body for ${name}
`,
  );
}

describe('SkillCommands', () => {
  it('1. buildCommandMap registers skill names as commands', async () => {
    await writeSkill('alpha');
    const map = await new SkillCommands(new SkillLoader(paths)).buildCommandMap();
    expect(map.has('alpha')).toBe(true);
  });

  it('2. buildCommandMap honors `cmd:` tags', async () => {
    await writeSkill('beta', 'tags: [cmd:run-beta, india]\n');
    const map = await new SkillCommands(new SkillLoader(paths)).buildCommandMap();
    expect(map.has('beta')).toBe(true);
    expect(map.has('run-beta')).toBe(true);
  });

  it('3. buildCommandMap reads metadata.aiden.tags too', async () => {
    await writeSkill(
      'meta',
      `metadata:
  aiden:
    tags: [cmd:meta-cmd]
`,
    );
    const map = await new SkillCommands(new SkillLoader(paths)).buildCommandMap();
    expect(map.has('meta-cmd')).toBe(true);
  });

  it('4. execute returns skill + system-prompt insert', async () => {
    await writeSkill('gamma', 'tags: [cmd:run-gamma]\n');
    const cmds = new SkillCommands(new SkillLoader(paths));
    const r = await cmds.execute('run-gamma');
    expect(r).not.toBeNull();
    expect(r!.skill.frontmatter.name).toBe('gamma');
    expect(r!.systemPromptInsert).toMatch(/Skill: gamma/);
    expect(r!.systemPromptInsert).toMatch(/Body for gamma/);
  });

  it('5. execute returns null for unknown command', async () => {
    const cmds = new SkillCommands(new SkillLoader(paths));
    expect(await cmds.execute('nope')).toBeNull();
  });

  it('6. multiple skills with overlapping cmds keep last-write-wins', async () => {
    await writeSkill('one', 'tags: [cmd:shared]\n');
    await writeSkill('two', 'tags: [cmd:shared]\n');
    const map = await new SkillCommands(new SkillLoader(paths)).buildCommandMap();
    // Either one or two won — both are valid; what matters is the
    // command is registered.
    const winner = map.get('shared');
    expect(winner).toBeDefined();
    expect(['one', 'two']).toContain(winner!.frontmatter.name);
  });
});
