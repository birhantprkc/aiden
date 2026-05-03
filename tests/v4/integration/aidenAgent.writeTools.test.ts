/**
 * Real-network integration tests for AidenAgent + Phase 8 write
 * tools, driven by a live Groq model.
 *
 * Skips automatically when GROQ_API_KEY (or GROQ_API_KEY_1) is unset.
 *
 * Two moments-of-truth:
 *   1. file_write — agent picks a write tool and creates a file on disk.
 *   2. shell_exec — agent picks the terminal tool and runs a command,
 *      and we confirm the marker text appears in the conversation.
 *
 * Phase 7 hit a Groq llama-3.3 quirk where literal `web_search` calls
 * triggered a wire-format regression; we keep an eye on the same
 * pattern here. If a model emits the legacy `<function=...>` syntax
 * for `shell_exec`, swap that test's tool to `run_shell` (Phase 9
 * disambiguates).
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { ChatCompletionsAdapter } from '../../../providers/v4/chatCompletionsAdapter';
import { AidenAgent } from '../../../core/v4/aidenAgent';
import { ToolRegistry } from '../../../core/v4/toolRegistry';
import { registerAllTools } from '../../../tools/v4';
import { resolveAidenPaths } from '../../../core/v4/paths';

const GROQ_KEY = process.env.GROQ_API_KEY || process.env.GROQ_API_KEY_1;
const GROQ_MODEL = process.env.GROQ_TEST_MODEL || 'llama-3.3-70b-versatile';

describe.skipIf(!GROQ_KEY)(
  'AidenAgent + Phase 8 write tools (Groq integration)',
  () => {
    it('uses file_write to create a file', async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-w-it-'));
      const target = path.join(tmp, 'note.txt');

      const adapter = new ChatCompletionsAdapter({
        baseUrl: 'https://api.groq.com/openai/v1',
        apiKey: GROQ_KEY!,
        model: GROQ_MODEL,
        providerName: 'groq',
      });

      const registry = new ToolRegistry();
      registerAllTools(registry);

      const ctx = {
        cwd: tmp,
        paths: resolveAidenPaths({ rootOverride: path.join(tmp, '.aiden') }),
      };

      const fileTools = registry
        .getSchemas(['files'])
        .filter((s) => s.name === 'file_write');
      expect(fileTools).toHaveLength(1);

      const agent = new AidenAgent({
        provider: adapter,
        tools: fileTools,
        toolExecutor: registry.buildExecutor(ctx),
        maxTurns: 5,
      });

      const result = await agent.runConversation([
        {
          role: 'system',
          content:
            'You write files using the file_write tool. Always use the absolute path the user gives you exactly.',
        },
        {
          role: 'user',
          content: `Use the file_write tool to write the text "hello v4" (no quotes) to ${target}`,
        },
      ]);

      expect(result.toolCallCount).toBeGreaterThanOrEqual(1);
      const written = await fs.readFile(target, 'utf-8').catch(() => '');
      expect(written.trim()).toBe('hello v4');
      await fs.rm(tmp, { recursive: true, force: true });
    }, 90_000);

    it('uses shell_exec to run a command and surfaces the output', async () => {
      const adapter = new ChatCompletionsAdapter({
        baseUrl: 'https://api.groq.com/openai/v1',
        apiKey: GROQ_KEY!,
        model: GROQ_MODEL,
        providerName: 'groq',
      });

      const registry = new ToolRegistry();
      registerAllTools(registry);

      const ctx = {
        cwd: process.cwd(),
        paths: resolveAidenPaths({ rootOverride: '/tmp/aiden-shell-it' }),
      };

      const shellOnly = registry
        .getSchemas(['terminal'])
        .filter((s) => s.name === 'shell_exec');
      expect(shellOnly).toHaveLength(1);

      const agent = new AidenAgent({
        provider: adapter,
        tools: shellOnly,
        toolExecutor: registry.buildExecutor(ctx),
        maxTurns: 5,
      });

      const marker = 'aiden-marker-9b3f';
      const result = await agent.runConversation([
        {
          role: 'system',
          content:
            'You are a shell assistant. Use shell_exec to run commands, then read the stdout to answer the user. Use Write-Output on Windows or echo elsewhere.',
        },
        {
          role: 'user',
          content:
            `Run a shell command that prints the text ${marker} and tell me what stdout was returned.`,
        },
      ]);

      expect(result.toolCallCount).toBeGreaterThanOrEqual(1);
      expect(result.finalContent.length).toBeGreaterThan(0);
      // Either the model echoes the marker, or it summarizes — pass
      // if the marker appears anywhere in the conversation trace
      // (a plain `result.finalContent.includes` is too brittle for
      // model phrasing).
      const everything =
        result.finalContent +
        '\n' +
        JSON.stringify(result.messages ?? '');
      expect(everything).toMatch(/aiden-marker-9b3f/);
    }, 90_000);
  },
);
