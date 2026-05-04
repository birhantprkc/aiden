import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { skillsListTool } from '../../../tools/v4/skills/skillsList';
import { skillViewTool } from '../../../tools/v4/skills/skillView';
import { skillManageTool } from '../../../tools/v4/skills/skillManage';
import { makeLookupToolSchema } from '../../../tools/v4/skills/lookupToolSchema';
import { ToolRegistry } from '../../../core/v4/toolRegistry';
import { resolveAidenPaths, type AidenPaths } from '../../../core/v4/paths';
import { SkillLoader } from '../../../core/v4/skillLoader';
import { BundledManifest } from '../../../core/v4/skillBundledManifest';
import type { ToolContext } from '../../../core/v4/toolRegistry';

let tmp: string;
let paths: AidenPaths;
let ctx: ToolContext;

const skillFile = (
  name: string,
  body = '# Body',
): string => `---
name: ${name}
description: ${name} desc
version: 1.0.0
---

${body}
`;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-skill-tools-'));
  paths = resolveAidenPaths({ rootOverride: tmp });
  await fs.mkdir(paths.skillsDir, { recursive: true });
  ctx = {
    cwd: tmp,
    paths,
    skillLoader: new SkillLoader(paths),
    skillManifest: new BundledManifest(paths),
  };
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('skills_list', () => {
  it('1. returns name+description for every loaded skill', async () => {
    await fs.mkdir(path.join(paths.skillsDir, 'alpha'));
    await fs.writeFile(
      path.join(paths.skillsDir, 'alpha', 'SKILL.md'),
      skillFile('alpha'),
    );
    await fs.mkdir(path.join(paths.skillsDir, 'beta'));
    await fs.writeFile(
      path.join(paths.skillsDir, 'beta', 'SKILL.md'),
      skillFile('beta'),
    );
    const r = (await skillsListTool.execute({}, ctx)) as {
      success: boolean;
      count: number;
      skills: Array<{ name: string; description: string }>;
    };
    expect(r.success).toBe(true);
    expect(r.count).toBe(2);
    expect(r.skills.map((s) => s.name).sort()).toEqual(['alpha', 'beta']);
  });

  it('2. surfaces userModified flag from manifest', async () => {
    await fs.mkdir(path.join(paths.skillsDir, 'mod'));
    await fs.writeFile(
      path.join(paths.skillsDir, 'mod', 'SKILL.md'),
      skillFile('mod'),
    );
    await ctx.skillManifest!.upsert('mod', {
      hash: 'will-not-match',
      userModified: false,
      installedAt: 0,
    });
    const r = (await skillsListTool.execute({}, ctx)) as {
      skills: Array<{ name: string; userModified: boolean | null }>;
    };
    const mod = r.skills.find((s) => s.name === 'mod');
    expect(mod?.userModified).toBe(true); // hash mismatch → modified
  });
});

describe('skill_view', () => {
  it('3. returns full SKILL.md content when no path', async () => {
    await fs.mkdir(path.join(paths.skillsDir, 'view-me'));
    await fs.writeFile(
      path.join(paths.skillsDir, 'view-me', 'SKILL.md'),
      skillFile('view-me', '# Detailed body'),
    );
    const r = (await skillViewTool.execute(
      { name: 'view-me' },
      ctx,
    )) as { success: boolean; content: string };
    expect(r.success).toBe(true);
    expect(r.content).toMatch(/Detailed body/);
  });

  it('4. returns reference file content when path is given', async () => {
    const dir = path.join(paths.skillsDir, 'with-ref');
    await fs.mkdir(path.join(dir, 'templates'), { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), skillFile('with-ref'));
    await fs.writeFile(path.join(dir, 'templates', 'note.txt'), 'TEMPLATE');
    const r = (await skillViewTool.execute(
      { name: 'with-ref', path: 'templates/note.txt' },
      ctx,
    )) as { success: boolean; content: string };
    expect(r.success).toBe(true);
    expect(r.content).toBe('TEMPLATE');
  });

  it('5. returns error for non-existent skill', async () => {
    const r = (await skillViewTool.execute(
      { name: 'nope' },
      ctx,
    )) as { success: boolean; error: string };
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not found/i);
  });
});

describe('skill_manage', () => {
  it('6. create writes a new skill', async () => {
    const r = (await skillManageTool.execute(
      { action: 'create', name: 'shiny', content: skillFile('shiny') },
      ctx,
    )) as { success: boolean; filePath: string };
    expect(r.success).toBe(true);
    const onDisk = await fs.readFile(
      path.join(paths.skillsDir, 'shiny', 'SKILL.md'),
      'utf-8',
    );
    expect(onDisk).toMatch(/name: shiny/);
  });

  it('7. create rejects duplicate name', async () => {
    await fs.mkdir(path.join(paths.skillsDir, 'dup'));
    await fs.writeFile(
      path.join(paths.skillsDir, 'dup', 'SKILL.md'),
      skillFile('dup'),
    );
    const r = (await skillManageTool.execute(
      { action: 'create', name: 'dup', content: skillFile('dup') },
      ctx,
    )) as { success: boolean; error: string };
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/already exists/);
  });

  it('8. delete removes the skill directory', async () => {
    await fs.mkdir(path.join(paths.skillsDir, 'goner'));
    await fs.writeFile(
      path.join(paths.skillsDir, 'goner', 'SKILL.md'),
      skillFile('goner'),
    );
    const r = (await skillManageTool.execute(
      { action: 'delete', name: 'goner' },
      ctx,
    )) as { success: boolean };
    expect(r.success).toBe(true);
    await expect(
      fs.access(path.join(paths.skillsDir, 'goner')),
    ).rejects.toThrow();
  });

  it('9. patch applies a unique find/replace', async () => {
    await fs.mkdir(path.join(paths.skillsDir, 'p'));
    await fs.writeFile(
      path.join(paths.skillsDir, 'p', 'SKILL.md'),
      skillFile('p', '# Original heading'),
    );
    const r = (await skillManageTool.execute(
      {
        action: 'patch',
        name: 'p',
        find: 'Original heading',
        replace: 'New heading',
      },
      ctx,
    )) as { success: boolean };
    expect(r.success).toBe(true);
    const after = await fs.readFile(
      path.join(paths.skillsDir, 'p', 'SKILL.md'),
      'utf-8',
    );
    expect(after).toMatch(/New heading/);
  });

  it('10. write_file writes inside skill dir; refuses traversal', async () => {
    await fs.mkdir(path.join(paths.skillsDir, 'wf'));
    await fs.writeFile(
      path.join(paths.skillsDir, 'wf', 'SKILL.md'),
      skillFile('wf'),
    );
    const ok = (await skillManageTool.execute(
      {
        action: 'write_file',
        name: 'wf',
        filePath: 'docs/extra.md',
        fileContent: 'extra',
      },
      ctx,
    )) as { success: boolean };
    expect(ok.success).toBe(true);
    const written = await fs.readFile(
      path.join(paths.skillsDir, 'wf', 'docs', 'extra.md'),
      'utf-8',
    );
    expect(written).toBe('extra');

    const traversal = (await skillManageTool.execute(
      {
        action: 'write_file',
        name: 'wf',
        filePath: '../escape.md',
        fileContent: 'pwn',
      },
      ctx,
    )) as { success: boolean; error: string };
    expect(traversal.success).toBe(false);
    expect(traversal.error).toMatch(/traversal/i);
  });

  it('11. is registered as write/mutating', () => {
    expect(skillManageTool.category).toBe('write');
    expect(skillManageTool.mutates).toBe(true);
    expect(skillManageTool.toolset).toBe('skills');
  });
});

describe('lookup_tool_schema (Phase 7 carry-over)', () => {
  it('12. returns the schema of a registered tool', async () => {
    const reg = new ToolRegistry();
    reg.register(skillsListTool);
    const lookup = makeLookupToolSchema(reg);
    reg.register(lookup);

    const result = (await lookup.execute({ toolName: 'skills_list' }, ctx)) as {
      success: boolean;
      schema: { name: string };
      category: string;
    };
    expect(result.success).toBe(true);
    expect(result.schema.name).toBe('skills_list');
    expect(result.category).toBe('read');
  });

  it('13. returns availableTools list when name is unknown', async () => {
    const reg = new ToolRegistry();
    reg.register(skillsListTool);
    const lookup = makeLookupToolSchema(reg);
    reg.register(lookup);
    const result = (await lookup.execute({ toolName: 'nope' }, ctx)) as {
      success: boolean;
      error: string;
      availableTools: string[];
    };
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not registered/);
    expect(result.availableTools).toContain('skills_list');
  });
});
