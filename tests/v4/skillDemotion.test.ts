/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12 OM.1 — posture-aware names-only skill demotion + categorization.
 *
 * The index keeps EVERY skill name (war-story #3: never fully hide — models
 * don't reliably call skills_list to rediscover hidden skills); off-posture /
 * low-trust entries just drop the teaser. Conservative on ambiguity.
 */
import { describe, it, expect } from 'vitest';
import { PromptBuilder, shouldDemoteSkill } from '../../core/v4/promptBuilder';

const TS = (...t: string[]) => new Set(t);

describe('shouldDemoteSkill', () => {
  it('KEEPS a posture-relevant categorized skill (category matches a loaded toolset)', () => {
    expect(shouldDemoteSkill({ category: 'browser', trustLevel: 'community' }, TS('browser'))).toBe(false);
  });
  it('KEEPS a user-modified (project-local) skill regardless of posture', () => {
    expect(shouldDemoteSkill({ category: 'git', trustLevel: 'community', userModified: true }, TS('browser'))).toBe(false);
  });
  it('DEMOTES a community skill that is off-posture', () => {
    expect(shouldDemoteSkill({ category: 'git', trustLevel: 'community' }, TS('browser'))).toBe(true);
  });
  it('DEMOTES a categorized off-posture skill of any trust', () => {
    expect(shouldDemoteSkill({ category: 'video', trustLevel: 'official' }, TS('browser'))).toBe(true);
  });
  it('KEEPS an uncategorized non-community skill (ambiguous → conservative)', () => {
    expect(shouldDemoteSkill({ trustLevel: 'trusted' }, TS('browser'))).toBe(false);
    expect(shouldDemoteSkill({}, TS('browser'))).toBe(false);
  });
});

async function buildSkillsBlock(
  skills: Array<{ name: string; description: string; category?: string; trustLevel?: string; userModified?: boolean }>,
  toolsets: Set<string>,
): Promise<string> {
  const out = await new PromptBuilder().build({
    paths: { soulMd: '/nonexistent/SOUL.md' } as never,
    skipFilesystem: true,
    skillsList: skills,
    toolsetsLoaded: toolsets,
  } as never);
  return out;
}

describe('OM.1 — skills block rendering', () => {
  const skills = [
    { name: 'browse-web', description: 'drive the browser to do X', category: 'browser', trustLevel: 'official' },
    { name: 'git-flow', description: 'manage git branches and PRs', category: 'git', trustLevel: 'community' },
    { name: 'edit-video', description: 'cut and render video clips', category: 'video', trustLevel: 'community' },
    { name: 'my-local', description: 'a workflow I authored', category: 'misc', trustLevel: 'community', userModified: true },
    { name: 'general-helper', description: 'broadly useful helper', trustLevel: 'trusted' }, // no category
  ];

  it('relevant-category skill keeps its teaser; off-posture demote to names-only', async () => {
    const block = await buildSkillsBlock(skills, TS('browser'));
    expect(block).toMatch(/- browse-web: drive the browser/);   // relevant → full teaser
    expect(block).toMatch(/- git-flow(\n|$)/);                   // off-posture community → name-only
    expect(block).not.toMatch(/- git-flow: manage git/);        // teaser dropped
    expect(block).toMatch(/- edit-video(\n|$)/);                 // off-posture → name-only
  });

  it('NEVER removes an entry — every skill NAME is still present', async () => {
    const block = await buildSkillsBlock(skills, TS('browser'));
    for (const s of skills) expect(block).toContain(`- ${s.name}`);
  });

  it('categorization buckets: user-modified + uncategorized-trusted keep teasers', async () => {
    const block = await buildSkillsBlock(skills, TS('browser'));
    expect(block).toMatch(/- my-local: a workflow I authored/);     // project-local → full
    expect(block).toMatch(/- general-helper: broadly useful/);      // uncategorized non-community → full
  });

  it('★ measurably shrinks vs all-teasers (the 48% win)', async () => {
    const posture = await buildSkillsBlock(skills, TS('browser'));
    // baseline: nothing loaded relevant → but force "all teasers" by marking all relevant
    const allTeasers = await buildSkillsBlock(
      skills.map((s) => ({ ...s, userModified: true })), // userModified → all keep teasers
      TS('browser'),
    );
    expect(posture.length).toBeLessThan(allTeasers.length); // demotion reduced the block
  });

  it('a different posture keeps different skills full (posture-aware)', async () => {
    const gitPosture = await buildSkillsBlock(skills, TS('git'));
    expect(gitPosture).toMatch(/- git-flow: manage git/);        // now relevant → full
    expect(gitPosture).not.toMatch(/- browse-web: drive/);       // browser now off-posture → name-only
    expect(gitPosture).toMatch(/- browse-web(\n|$)/);            // still present
  });
});
