/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/model.ts — Phase 14b
 *
 * `/model [provider:model | model]` — switches the live session's
 * provider/model. Empty args opens the interactive picker (also reused by
 * `aiden model`). Spec form is parsed via Phase 5's ModelSwitcher.
 */
import path from 'node:path';
import fs from 'node:fs';

import type { SlashCommand, SlashCommandContext } from '../commandRegistry';
import { ModelSwitcher } from '../../../providers/v4/modelSwitch';
import { runModelPicker } from './modelPicker';
import { PROVIDER_REGISTRY } from '../../../providers/v4/registry';

/**
 * Sync auth-state probe used by the Phase 22 picker. Single source of
 * truth for "is this provider usable right now":
 *   - local providers (ollama) — assume authed; the actual switch
 *     surfaces a daemon-not-reachable error if not.
 *   - OAuth providers — token file at <root>/auth/<oauth-id>.json must
 *     exist. Token validity is the runtime resolver's concern.
 *   - env-var providers — process.env[apiKeyEnvVar] must be non-empty.
 */
function makeAuthProbe(rootPath: string | undefined): (id: string) => boolean {
  return (providerId: string): boolean => {
    const entry = PROVIDER_REGISTRY[providerId];
    if (!entry) return false;
    if (entry.tier === 'local') return true;
    if (entry.oauth && rootPath) {
      try {
        fs.accessSync(path.join(rootPath, 'auth', `${entry.oauth.providerId}.json`));
        return true;
      } catch {
        return false;
      }
    }
    if (entry.apiKeyEnvVar) {
      const v = process.env[entry.apiKeyEnvVar];
      return typeof v === 'string' && v.length > 0;
    }
    return false;
  };
}

export const model: SlashCommand = {
  name: 'model',
  description: 'Switch the active provider/model (interactive when no args).',
  category: 'system',
  icon: '🧠',
  handler: async (ctx: SlashCommandContext) => {
    if (!ctx.resolver) {
      ctx.display.warn('No runtime resolver wired — cannot switch model.');
      return {};
    }
    let providerId: string | undefined;
    let modelId: string | undefined;

    const spec = ctx.rawArgs.trim();
    if (spec) {
      try {
        const switcher = new ModelSwitcher(ctx.resolver);
        const parsed = switcher.parse(spec);
        if (!parsed.providerId) {
          ctx.display.printError(`Unable to resolve '${spec}'.`);
          return {};
        }
        providerId = parsed.providerId;
        modelId = parsed.modelId;
      } catch (err) {
        ctx.display.printError(
          (err as Error).message,
          'Try `provider:model`, e.g. anthropic:claude-opus-4-7.',
        );
        return {};
      }
    } else {
      const picked = await runModelPicker({
        resolver: ctx.resolver,
        currentProviderId: ctx.session?.getCurrentProvider(),
        currentModelId: ctx.session?.getCurrentModel(),
        isProviderAuthed: makeAuthProbe(ctx.paths?.root),
      });
      if (!picked) {
        ctx.display.dim('Model unchanged.');
        return {};
      }
      providerId = picked.providerId;
      modelId = picked.modelId;
    }

    if (ctx.session) {
      try {
        await ctx.session.setProvider(providerId, modelId);
      } catch (err) {
        ctx.display.printError(`Switch failed: ${(err as Error).message}`);
        return {};
      }
    }
    ctx.display.success(`Now using ${providerId}:${modelId}`);
    return {};
  },
};
