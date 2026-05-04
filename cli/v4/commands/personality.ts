/**
 * cli/v4/commands/personality.ts — Phase 16a
 *
 * `/personality`           list available + show current
 * `/personality <name>`    switch active personality
 * `/personality default`   revert to default (no overlay on SOUL.md)
 */
import type { SlashCommand } from '../commandRegistry';

export const personality: SlashCommand = {
  name: 'personality',
  description: 'Show or switch the personality overlay layered on SOUL.md.',
  category: 'system',
  icon: '🎭',
  handler: async (ctx) => {
    const mgr = ctx.personalityManager;
    if (!mgr) {
      ctx.display.warn('Personality manager not wired in this context.');
      return {};
    }
    const target = ctx.rawArgs.trim();
    if (!target) {
      const list = await mgr.list();
      const current = mgr.getCurrent();
      ctx.display.info(`Active personality: ${current}`);
      ctx.display.info('Available personalities:');
      for (const p of list) {
        const marker = p.name === current ? '*' : ' ';
        const tag = p.source === 'user' ? ' (user)' : '';
        const desc = p.description ? ` — ${p.description}` : '';
        ctx.display.write(`  ${marker} ${p.name}${tag}${desc}\n`);
      }
      return {};
    }
    const result = await mgr.setCurrent(target);
    if (!result.ok) {
      ctx.display.printError(
        result.reason ?? `Unknown personality '${target}'.`,
        'Run /personality to see available names.',
      );
      return {};
    }
    ctx.display.success(`Personality: ${mgr.getCurrent()}`);
    return {};
  },
};
