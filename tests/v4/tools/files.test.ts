import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { fileReadTool } from '../../../tools/v4/files/fileRead';
import { fileListTool } from '../../../tools/v4/files/fileList';
import { resolveAidenPaths } from '../../../core/v4/paths';
import type { ToolContext } from '../../../core/v4/toolRegistry';

let tmp: string;
let ctx: ToolContext;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-files-tool-'));
  ctx = {
    cwd: tmp,
    paths: resolveAidenPaths({ rootOverride: path.join(tmp, '.aiden') }),
  };
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('file tools — schemas', () => {
  it('1. file_read schema requires path', () => {
    expect(fileReadTool.schema.name).toBe('file_read');
    expect(fileReadTool.schema.inputSchema.required).toEqual(['path']);
    expect(fileReadTool.toolset).toBe('files');
    expect(fileReadTool.mutates).toBe(false);
    expect(fileReadTool.category).toBe('read');
  });

  it('2. file_list schema is path-optional', () => {
    expect(fileListTool.schema.name).toBe('file_list');
    expect(fileListTool.schema.inputSchema.required).toBeUndefined();
    expect(fileListTool.mutates).toBe(false);
  });
});

describe('file_read', () => {
  it('3. reads a file relative to ctx.cwd', async () => {
    await fs.writeFile(path.join(tmp, 'hello.txt'), 'world');
    const result = (await fileReadTool.execute({ path: 'hello.txt' }, ctx)) as {
      success: boolean;
      content: string;
    };
    expect(result.success).toBe(true);
    expect(result.content).toBe('world');
  });

  it('4. truncates content to 5000 chars and reports truncated=true', async () => {
    const big = 'x'.repeat(10_000);
    await fs.writeFile(path.join(tmp, 'big.txt'), big);
    const result = (await fileReadTool.execute({ path: 'big.txt' }, ctx)) as {
      success: boolean;
      content: string;
      truncated: boolean;
      size: number;
    };
    expect(result.success).toBe(true);
    expect(result.content.length).toBe(5000);
    expect(result.truncated).toBe(true);
    expect(result.size).toBe(10_000);
  });

  it('5. blocks denied paths (.ssh, .pem, credentials)', async () => {
    const denied = (
      await Promise.all(
        [
          path.join(tmp, '.ssh', 'id_rsa'),
          path.join(tmp, 'host.pem'),
          path.join(tmp, 'aws-credentials.json'),
        ].map(async (p) => {
          const result = await fileReadTool.execute({ path: p }, ctx);
          return result;
        }),
      )
    ) as { success: boolean; error: string }[];
    for (const r of denied) {
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/protected/i);
    }
  });

  it('6. returns error result for missing file', async () => {
    const result = (await fileReadTool.execute(
      { path: 'does-not-exist.txt' },
      ctx,
    )) as { success: boolean; error: string };
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ENOENT|no such file/i);
  });

  it('7. requires a path argument', async () => {
    const result = (await fileReadTool.execute({}, ctx)) as {
      success: boolean;
      error: string;
    };
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no path/i);
  });
});

describe('file_list', () => {
  it('8. lists entries with type discrimination', async () => {
    await fs.writeFile(path.join(tmp, 'a.txt'), '');
    await fs.mkdir(path.join(tmp, 'subdir'));
    const result = (await fileListTool.execute({ path: tmp }, ctx)) as {
      success: boolean;
      entries: { name: string; type: string }[];
    };
    expect(result.success).toBe(true);
    const names = result.entries.map((e) => e.name).sort();
    expect(names).toEqual(['a.txt', 'subdir']);
    const a = result.entries.find((e) => e.name === 'a.txt');
    const sub = result.entries.find((e) => e.name === 'subdir');
    expect(a?.type).toBe('file');
    expect(sub?.type).toBe('dir');
  });

  it('9. defaults to ctx.cwd when path is omitted', async () => {
    await fs.writeFile(path.join(tmp, 'only.txt'), '');
    const result = (await fileListTool.execute({}, ctx)) as {
      success: boolean;
      entries: { name: string }[];
    };
    expect(result.success).toBe(true);
    expect(result.entries.map((e) => e.name)).toContain('only.txt');
  });

  it('10. returns error for missing dir', async () => {
    const result = (await fileListTool.execute(
      { path: path.join(tmp, 'nope') },
      ctx,
    )) as { success: boolean; error: string };
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ENOENT|no such/i);
  });
});
