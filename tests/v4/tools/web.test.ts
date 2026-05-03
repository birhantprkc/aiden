import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../core/webSearch', () => ({
  reliableWebSearch: vi.fn(),
  deepResearch: vi.fn(),
}));

import { reliableWebSearch, deepResearch } from '../../../core/webSearch';
import { webSearchTool } from '../../../tools/v4/web/webSearch';
import { webFetchTool } from '../../../tools/v4/web/webFetch';
import { webPageTool } from '../../../tools/v4/web/webPage';
import { deepResearchTool } from '../../../tools/v4/web/deepResearch';
import { resolveAidenPaths } from '../../../core/v4/paths';
import type { ToolContext } from '../../../core/v4/toolRegistry';

const ctx: ToolContext = {
  cwd: process.cwd(),
  paths: resolveAidenPaths({ rootOverride: '/tmp/aiden-test-root' }),
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.clearAllMocks();
});

describe('web tools', () => {
  it('1. web_search schema declares query as required', () => {
    expect(webSearchTool.schema.name).toBe('web_search');
    expect(webSearchTool.schema.inputSchema.required).toEqual(['query']);
    expect(webSearchTool.toolset).toBe('web');
    expect(webSearchTool.mutates).toBe(false);
  });

  it('2. web_search delegates to reliableWebSearch', async () => {
    (reliableWebSearch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
      output: 'mock answer',
    });
    const result = (await webSearchTool.execute({ query: 'aiden v4' }, ctx)) as {
      success: boolean;
      output: string;
    };
    expect(reliableWebSearch).toHaveBeenCalledWith('aiden v4');
    expect(result.success).toBe(true);
    expect(result.output).toBe('mock answer');
  });

  it('3. web_search rejects empty query without calling underlying', async () => {
    const result = (await webSearchTool.execute({ query: '   ' }, ctx)) as {
      success: boolean;
      error: string;
    };
    expect(reliableWebSearch).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no query/i);
  });

  it('4. fetch_url returns stripped HTML body and HTTP status', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      statusText: 'OK',
      text: async () =>
        '<html><script>bad()</script><body>Hello <b>World</b></body></html>',
    }) as unknown as typeof fetch;
    const result = (await webFetchTool.execute(
      { url: 'https://example.com' },
      ctx,
    )) as { success: boolean; status: number; body: string };
    expect(result.success).toBe(true);
    expect(result.status).toBe(200);
    expect(result.body).not.toContain('<script>');
    expect(result.body).toContain('Hello');
    expect(result.body).toContain('World');
  });

  it('5. fetch_url returns error when fetch throws', async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    const result = (await webFetchTool.execute(
      { url: 'https://example.com' },
      ctx,
    )) as { success: boolean; error: string };
    expect(result.success).toBe(false);
    expect(result.error).toBe('ECONNREFUSED');
  });

  it('6. fetch_url rejects empty url', async () => {
    const result = (await webFetchTool.execute({ url: '' }, ctx)) as {
      success: boolean;
      error: string;
    };
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no url/i);
  });

  it('7. fetch_page strips all tags and collapses whitespace', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      text: async () =>
        '<html><head><style>x{}</style></head><body><h1>Title</h1>\n<p>Body  text.</p></body></html>',
    }) as unknown as typeof fetch;
    const result = (await webPageTool.execute(
      { url: 'https://example.com' },
      ctx,
    )) as { success: boolean; content: string };
    expect(result.success).toBe(true);
    expect(result.content).toBe('Title Body text.');
  });

  it('8. deep_research delegates to deepResearch with the topic', async () => {
    (deepResearch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
      output: 'researched',
    });
    const result = (await deepResearchTool.execute(
      { topic: 'agent loops' },
      ctx,
    )) as { success: boolean; output: string };
    expect(deepResearch).toHaveBeenCalledWith('agent loops');
    expect(result.success).toBe(true);
    expect(result.output).toBe('researched');
  });
});
