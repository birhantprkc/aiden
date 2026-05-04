/**
 * cli/v4/commands/personality.ts — Phase 16a; Phase 16b.4 wiring
 *
 * `/personality`           list available + show current
 * `/personality <name>`    switch active personality (live — invalidates the
 *                          agent's cached system prompt so the next turn
 *                          rebuilds with the new slot-2 overlay)
 * `/personality default`   revert to default (no overlay layered on SOUL.md)
 * `/personality show`      dump the current overlay body
 *
 * Hermes diverges — Hermes has no /personality, users edit SOUL.md directly.
 * Aiden keeps a separate manager because v4 UX docs treat overlays as a
 * runtime-switchable layer above (not replacing) the SOUL.md identity.
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

    // ── /personality (no args) ── list + current
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

    // ── /personality show ── dump current overlay body
    if (target === 'show') {
      const current = mgr.getCurrent();
      const body = await mgr.getActiveOverlay();
      ctx.display.info(`Personality '${current}' overlay (slot 2):`);
      ctx.display.write('\n');
      if (!body || !body.trim()) {
        ctx.display.dim('(empty — SOUL.md is used as the sole identity layer)');
      } else {
        ctx.display.write(body.trimEnd() + '\n');
      }
      return {};
    }

    // ── /personality <name> ── switch
    const result = await mgr.setCurrent(target);
    if (!result.ok) {
      ctx.display.printError(
        result.reason ?? `Unknown personality '${target}'.`,
        'Run /personality to see available names.',
      );
      return {};
    }

    // Push the new overlay into the agent's frozen prompt options. The agent
    // invalidates its cached system prompt on overlay change so the next
    // runConversation call rebuilds slot 2 from the new body. SOUL.md (slot
    // 1) and the rest of the slot order are untouched — overlays never
    // replace identity.
    if (ctx.agent) {
      const newOverlay = await mgr.getActiveOverlay();
      ctx.agent.setPersonalityOverlay(newOverlay);
    }
    ctx.display.success(`Personality: ${mgr.getCurrent()}`);
    return {};
  },
};
