/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/home.ts — v4.12 /commands slice.
 *
 * `/home` — show or change Aiden's working directory (where file_* tools
 * resolve relative paths and where shell_exec / process spawns run).
 *
 *   /home           → print the current working directory.
 *   /home <path>    → validate <path> exists + is a directory, resolve to
 *                     absolute, and switch to it.
 *
 * The change takes real effect: `ctx.setWorkingDir` (wired by aidenCLI)
 * calls `process.chdir()`, patches the live tool-executor `ToolContext.cwd`
 * (snapshotted at boot), and rebuilds the sandbox fs allow-list against the
 * new cwd — so subsequent file/shell tool calls honour it, not just the
 * display. If the seam is absent (a context that can't change cwd), the
 * command says so rather than implying an effect it can't deliver.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { SlashCommand } from '../commandRegistry';

export const home: SlashCommand = {
  name: 'home',
  description: "Show or change Aiden's working directory (/home [path]).",
  category: 'system',
  icon: '⌂',
  handler: async (ctx) => {
    // rawArgs (not args[]) so paths containing spaces survive.
    const arg = ctx.rawArgs.trim();

    // No arg → show the current working directory.
    if (!arg) {
      ctx.display.info(`Working directory: ${process.cwd()}`);
      return {};
    }

    const target = path.resolve(process.cwd(), arg);

    // Validate: must exist AND be a directory — never set a bad cwd.
    let stat: fs.Stats;
    try {
      stat = fs.statSync(target);
    } catch {
      ctx.display.printError(`No such path: ${target}`, 'Pass an existing directory: /home <path>');
      return {};
    }
    if (!stat.isDirectory()) {
      ctx.display.printError(`Not a directory: ${target}`, 'The working directory must be a folder.');
      return {};
    }

    if (!ctx.setWorkingDir) {
      ctx.display.warn('Changing the working directory is not available in this context.');
      return {};
    }
    try {
      ctx.setWorkingDir(target);
    } catch (e) {
      ctx.display.printError(`Failed to change directory: ${(e as Error).message}`);
      return {};
    }
    ctx.display.success(`Working directory → ${target}`);
    ctx.display.dim('File and shell tools now resolve relative paths from here.');
    return {};
  },
};
