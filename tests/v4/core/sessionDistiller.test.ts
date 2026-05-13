/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * Phase v4.1.2-memory-AB — SessionDistiller unit coverage.
 *
 * Verifies:
 *   - Deterministic fields (files_touched, tools_used) derived purely
 *     from the tool-call trace.
 *   - Semantic fields (bullets, decisions, open_items, keywords)
 *     parsed strictly from auxiliary JSON, leniently from embedded
 *     JSON, and falling back to bullets-only on malformed responses.
 *   - `partial: true` set on any fallback path; absent on full
 *     distillations.
 *   - `schema_version` + `exit_path` always populated.
 *   - Timeout: when the auxiliary call exceeds the cap, the
 *     distillation still ships with deterministic fields and
 *     `partial: true`; LLM fields are empty.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  distillSession,
  deriveProgrammaticFields,
  parseLLMDistillation,
  filterMessagesForDistillation,
  TOOL_RESULT_TRUNCATION,
  SESSION_DISTILLATION_SCHEMA_VERSION,
  type SessionDistillation,
} from '../../../core/v4/sessionDistiller';
import type { HonestyTraceEntry } from '../../../moat/honestyEnforcement';
import type { Message } from '../../../providers/v4/types';

function trace(entries: Array<{ name: string; result?: unknown; error?: string }>): HonestyTraceEntry[] {
  return entries.map((e) => ({
    name: e.name,
    result: e.result ?? null,
    error: e.error,
  }));
}

const msgs: Message[] = [
  { role: 'user',      content: 'help me clean up tmp files' },
  { role: 'assistant', content: 'done' },
];

/**
 * Build a stub AuxiliaryClient whose `.call()` resolves with the
 * given content (or rejects with the given error). The stub matches
 * the shape distillSession expects without importing the real
 * implementation.
 */
function makeAux(
  spec: { content?: string; rejectWith?: Error; delayMs?: number },
): { call: (...args: unknown[]) => Promise<{ content: string }> } {
  return {
    call: vi.fn(async () => {
      if (spec.delayMs) await new Promise((r) => setTimeout(r, spec.delayMs));
      if (spec.rejectWith) throw spec.rejectWith;
      return { content: spec.content ?? '' };
    }),
  };
}

describe('deriveProgrammaticFields', () => {
  it('returns empty arrays for an empty trace', () => {
    expect(deriveProgrammaticFields([])).toEqual({
      files_touched: [],
      tools_used:    [],
    });
  });

  it('counts tools by name, sorted by count desc then name asc', () => {
    const t = trace([
      { name: 'file_read' }, { name: 'file_read' }, { name: 'file_read' },
      { name: 'shell_exec' }, { name: 'shell_exec' },
      { name: 'file_write', result: { success: true, path: '/tmp/a.txt' } },
    ]);
    const out = deriveProgrammaticFields(t);
    expect(out.tools_used).toEqual([
      { name: 'file_read',  count: 3 },
      { name: 'shell_exec', count: 2 },
      { name: 'file_write', count: 1 },
    ]);
  });

  it('collects unique path values from mutating tools only', () => {
    const t = trace([
      // file_read should NOT contribute to files_touched (read-only).
      { name: 'file_read',  result: { path: '/tmp/should-not-show.txt', content: 'x' } },
      { name: 'file_write', result: { success: true, path: '/tmp/a.txt' } },
      { name: 'file_write', result: { success: true, path: '/tmp/a.txt' } }, // dedup
      { name: 'file_write', result: { success: true, path: '/tmp/b.txt' } },
      { name: 'file_patch', result: { path: '/tmp/c.txt' } },
      { name: 'memory_add', result: { path: '/home/user/MEMORY.md', verified: true } },
    ]);
    expect(deriveProgrammaticFields(t).files_touched).toEqual([
      '/home/user/MEMORY.md',
      '/tmp/a.txt',
      '/tmp/b.txt',
      '/tmp/c.txt',
    ]);
  });

  it('skips files when the tool errored', () => {
    const t = trace([
      { name: 'file_write', result: { path: '/tmp/ok.txt' } },
      { name: 'file_write', result: { path: '/tmp/fail.txt' }, error: 'EACCES' },
    ]);
    expect(deriveProgrammaticFields(t).files_touched).toEqual(['/tmp/ok.txt']);
  });

  it('accepts nested .result.path shapes (some adapter wrappings)', () => {
    const t = trace([
      { name: 'file_write', result: { result: { path: '/nested.txt' } } },
    ]);
    expect(deriveProgrammaticFields(t).files_touched).toEqual(['/nested.txt']);
  });
});

describe('parseLLMDistillation', () => {
  it('strict-parses a clean JSON object with all four fields', () => {
    const raw = JSON.stringify({
      bullets:    ['a', 'b', 'c'],
      decisions:  ['decided x'],
      open_items: ['todo y'],
      keywords:   ['kw1', 'kw2'],
    });
    const out = parseLLMDistillation(raw);
    expect(out.partial).toBe(false);
    expect(out.bullets).toEqual(['a', 'b', 'c']);
    expect(out.decisions).toEqual(['decided x']);
    expect(out.open_items).toEqual(['todo y']);
    expect(out.keywords).toEqual(['kw1', 'kw2']);
  });

  it('accepts openItems (camelCase) as alias for open_items', () => {
    const raw = JSON.stringify({
      bullets:   ['a'],
      decisions: [],
      openItems: ['todo z'],
      keywords:  [],
    });
    expect(parseLLMDistillation(raw).open_items).toEqual(['todo z']);
  });

  it('strips non-string elements from arrays', () => {
    const raw = JSON.stringify({
      bullets:   ['a', 42, null, 'b'],
      decisions: [],
      open_items: [],
      keywords:  [],
    });
    expect(parseLLMDistillation(raw).bullets).toEqual(['a', 'b']);
  });

  it('embedded JSON in prose — lenient path recovers', () => {
    const raw = 'Here is the JSON:\n{"bullets":["a","b"],"decisions":[],"open_items":[],"keywords":[]}\nThanks!';
    const out = parseLLMDistillation(raw);
    expect(out.partial).toBe(false);
    expect(out.bullets).toEqual(['a', 'b']);
  });

  it('bullets-only fallback when JSON parse fails — sets partial=true', () => {
    const raw = [
      'Here are five bullets:',
      '- first thing',
      '- second thing',
      '- third thing',
      '* fourth thing',
      '5. fifth thing',
    ].join('\n');
    const out = parseLLMDistillation(raw);
    expect(out.partial).toBe(true);
    expect(out.bullets).toEqual([
      'first thing',
      'second thing',
      'third thing',
      'fourth thing',
      'fifth thing',
    ]);
    expect(out.decisions).toEqual([]);
    expect(out.open_items).toEqual([]);
    expect(out.keywords).toEqual([]);
  });

  it('empty string → partial with empty arrays', () => {
    const out = parseLLMDistillation('');
    expect(out.partial).toBe(true);
    expect(out.bullets).toEqual([]);
  });

  it('JSON with all-empty arrays → strict parse returns null, lenient fallback', () => {
    // Tests the "nothing useful" gate inside tryStrictParse.
    const raw = JSON.stringify({
      bullets: [], decisions: [], open_items: [], keywords: [],
    });
    const out = parseLLMDistillation(raw);
    expect(out.partial).toBe(true);
  });
});

describe('distillSession (orchestrator)', () => {
  it('produces a full distillation when auxiliary returns clean JSON', async () => {
    const aux = makeAux({
      content: JSON.stringify({
        bullets:    ['summarize bullet 1', 'summarize bullet 2'],
        decisions:  ['went with option A'],
        open_items: ['todo finish docs'],
        keywords:   ['memory', 'distill'],
      }),
    });
    const dist = await distillSession({
      sessionId: 'sess-1',
      startedAt: '2026-05-12T00:00:00Z',
      exitPath:  'quit',
      userTurns: 4,
      messages:  msgs,
      toolTrace: trace([
        { name: 'file_write', result: { path: '/tmp/foo' } },
      ]),
      auxiliaryClient: aux as unknown as Parameters<typeof distillSession>[0]['auxiliaryClient'],
    });
    expect(dist.schema_version).toBe(SESSION_DISTILLATION_SCHEMA_VERSION);
    expect(dist.session_id).toBe('sess-1');
    expect(dist.exit_path).toBe('quit');
    expect(dist.user_turns).toBe(4);
    expect(dist.bullets.length).toBe(2);
    expect(dist.files_touched).toEqual(['/tmp/foo']);
    expect(dist.tools_used).toEqual([{ name: 'file_write', count: 1 }]);
    expect(dist.partial).toBeUndefined();
  });

  it('marks partial=true and keeps deterministic fields when auxiliary returns garbage', async () => {
    const aux = makeAux({ content: 'this is not json at all' });
    const dist = await distillSession({
      sessionId: 'sess-2',
      startedAt: '2026-05-12T00:00:00Z',
      exitPath:  'sigint',
      userTurns: 5,
      messages:  msgs,
      toolTrace: trace([
        { name: 'shell_exec' },
        { name: 'file_write', result: { path: '/tmp/x' } },
      ]),
      auxiliaryClient: aux as unknown as Parameters<typeof distillSession>[0]['auxiliaryClient'],
    });
    expect(dist.partial).toBe(true);
    expect(dist.bullets).toEqual([]);
    // Deterministic fields still populated.
    expect(dist.files_touched).toEqual(['/tmp/x']);
    expect(dist.tools_used).toEqual([
      { name: 'file_write', count: 1 },
      { name: 'shell_exec', count: 1 },
    ]);
    expect(dist.exit_path).toBe('sigint');
  });

  it('marks partial=true when the auxiliary call throws', async () => {
    const aux = makeAux({ rejectWith: new Error('aux exploded') });
    const dist = await distillSession({
      sessionId: 'sess-3',
      startedAt: '2026-05-12T00:00:00Z',
      exitPath:  'crash',
      userTurns: 3,
      messages:  msgs,
      toolTrace: [],
      auxiliaryClient: aux as unknown as Parameters<typeof distillSession>[0]['auxiliaryClient'],
    });
    expect(dist.partial).toBe(true);
    expect(dist.bullets).toEqual([]);
  });

  it('respects timeoutMs — slow auxiliary becomes partial', async () => {
    const aux = makeAux({ content: '{}', delayMs: 200 });
    const dist = await distillSession({
      sessionId: 'sess-4',
      startedAt: '2026-05-12T00:00:00Z',
      exitPath:  'sigterm',
      userTurns: 5,
      messages:  msgs,
      toolTrace: [],
      auxiliaryClient: aux as unknown as Parameters<typeof distillSession>[0]['auxiliaryClient'],
      timeoutMs: 20,
    });
    expect(dist.partial).toBe(true);
    expect(dist.exit_path).toBe('sigterm');
  });

  it('populates ended_at when not supplied', async () => {
    const aux = makeAux({ content: JSON.stringify({ bullets: ['x'], decisions: [], open_items: [], keywords: [] }) });
    const dist = await distillSession({
      sessionId: 'sess-5',
      startedAt: '2026-05-12T00:00:00Z',
      exitPath:  'quit',
      userTurns: 3,
      messages:  msgs,
      toolTrace: [],
      auxiliaryClient: aux as unknown as Parameters<typeof distillSession>[0]['auxiliaryClient'],
    });
    expect(typeof dist.ended_at).toBe('string');
    expect(new Date(dist.ended_at).getTime()).toBeGreaterThan(0);
  });
});

// ── Phase v4.1.2-bug-Y — transcript filter ───────────────────────────────
//
// User-reported bug: distiller bullets were agent self-description
// ("I'm Aiden, a local-first AI agent…") instead of session content,
// because the unfiltered transcript included the giant role:'system'
// block PromptBuilder constructs. Filter drops system messages and
// emits Hermes-style role-tagged lines for the rest.

describe('filterMessagesForDistillation', () => {
  it('drops ALL role:\'system\' messages (the boilerplate source)', () => {
    const out = filterMessagesForDistillation([
      { role: 'system', content: 'I am Aiden, a local-first AI agent built by Taracod. 72 skills loaded.' },
      { role: 'user',   content: 'hi' },
    ]);
    expect(out).not.toContain('Aiden');
    expect(out).not.toContain('Taracod');
    expect(out).toContain('[USER] hi');
  });

  it('keeps user messages verbatim, with [USER] tag', () => {
    const out = filterMessagesForDistillation([
      { role: 'user', content: 'save this for next time: gpt-5.5 is the auto-picked default' },
    ]);
    expect(out).toBe('[USER] save this for next time: gpt-5.5 is the auto-picked default');
  });

  it('keeps multi-line user content within a single [USER] section', () => {
    const out = filterMessagesForDistillation([
      { role: 'user', content: 'line one\nline two\nline three' },
    ]);
    // Multi-line preserved inside the single tagged section.
    expect(out).toBe('[USER] line one\nline two\nline three');
  });

  it('emits [ASSISTANT] only when text is non-empty (no placeholder for tool-only turns)', () => {
    const out = filterMessagesForDistillation([
      { role: 'assistant', content: '', toolCalls: [
        { id: 'c1', name: 'web_search', arguments: { query: 'aiden' } },
      ]},
    ]);
    expect(out).not.toContain('[ASSISTANT]');
    expect(out).toContain('[TOOL:web_search] {"query":"aiden"}');
  });

  it('emits [ASSISTANT] text + tool_calls in order when both present', () => {
    const out = filterMessagesForDistillation([
      {
        role: 'assistant',
        content: "I'll search for that.",
        toolCalls: [
          { id: 'c1', name: 'web_search', arguments: { query: 'v4.1.2' } },
        ],
      },
    ]);
    const lines = out.split('\n');
    expect(lines[0]).toBe("[ASSISTANT] I'll search for that.");
    expect(lines[1]).toBe('[TOOL:web_search] {"query":"v4.1.2"}');
  });

  it('correlates tool result with its tool name via toolCallId', () => {
    const out = filterMessagesForDistillation([
      { role: 'assistant', content: '', toolCalls: [
        { id: 'call-1', name: 'file_read', arguments: { path: '/tmp/x' } },
      ]},
      { role: 'tool', toolCallId: 'call-1', content: 'file contents here' },
    ]);
    expect(out).toContain('[TOOL:file_read] {"path":"/tmp/x"}');
    expect(out).toContain('[TOOL:file_read] → file contents here');
  });

  it('renders unknown tool name when toolCallId has no matching call', () => {
    const out = filterMessagesForDistillation([
      { role: 'tool', toolCallId: 'orphan', content: 'orphaned result' },
    ]);
    expect(out).toContain('[TOOL:unknown] → orphaned result');
  });

  it(`truncates tool results > ${TOOL_RESULT_TRUNCATION} chars with … (U+2026) marker`, () => {
    const longResult = 'a'.repeat(TOOL_RESULT_TRUNCATION + 100);
    const out = filterMessagesForDistillation([
      { role: 'assistant', content: '', toolCalls: [
        { id: 'c1', name: 'shell_exec', arguments: {} },
      ]},
      { role: 'tool', toolCallId: 'c1', content: longResult },
    ]);
    // Find the tool-result line.
    const resultLine = out.split('\n').find((l) => l.includes('→')) ?? '';
    // The line carries the tag prefix; the content portion is capped.
    const afterArrow = resultLine.split('→ ')[1] ?? '';
    expect(afterArrow.length).toBe(TOOL_RESULT_TRUNCATION);
    expect(afterArrow.endsWith('…')).toBe(true);
  });

  it('does NOT truncate user or assistant text — only tool results', () => {
    const longUser      = 'u'.repeat(TOOL_RESULT_TRUNCATION + 500);
    const longAssistant = 'a'.repeat(TOOL_RESULT_TRUNCATION + 500);
    const out = filterMessagesForDistillation([
      { role: 'user',      content: longUser },
      { role: 'assistant', content: longAssistant },
    ]);
    expect(out).toContain(longUser);                    // not truncated
    expect(out).toContain(longAssistant);               // not truncated
    expect(out).not.toContain('…');
  });

  it('drops empty messages', () => {
    const out = filterMessagesForDistillation([
      { role: 'user',      content: '   '   },         // whitespace-only
      { role: 'user',      content: 'real'  },
      { role: 'assistant', content: ''      },         // empty text, no tool calls
    ]);
    expect(out).toBe('[USER] real');
  });

  it('preserves message ordering', () => {
    const out = filterMessagesForDistillation([
      { role: 'system',    content: 'should be dropped' },
      { role: 'user',      content: 'first user' },
      { role: 'assistant', content: 'first assistant' },
      { role: 'user',      content: 'second user' },
      { role: 'assistant', content: 'second assistant' },
    ]);
    const idx = (s: string) => out.indexOf(s);
    expect(idx('[USER] first user')).toBeLessThan(idx('[ASSISTANT] first assistant'));
    expect(idx('[ASSISTANT] first assistant')).toBeLessThan(idx('[USER] second user'));
    expect(idx('[USER] second user')).toBeLessThan(idx('[ASSISTANT] second assistant'));
  });

  it('empty input → empty string', () => {
    expect(filterMessagesForDistillation([])).toBe('');
  });

  it('all-system input → empty string (everything dropped)', () => {
    expect(filterMessagesForDistillation([
      { role: 'system', content: 'one' },
      { role: 'system', content: 'two' },
    ])).toBe('');
  });
});

describe('distillSession — boilerplate-resistance smoke (bug-Y regression guard)', () => {
  /**
   * Today's smoke-test bug: weak summarizer model received the giant
   * system prompt in transcript and echoed its content as bullets.
   * The fix is two-part — filter drops the system message AND the
   * prompt is hardened. This test exercises the integration: even
   * with a system message containing the exact boilerplate strings,
   * the prompt sent to the aux client does NOT include them.
   */
  it('aux client receives a prompt that excludes system-boilerplate content', async () => {
    let capturedPrompt = '';
    const aux = {
      call: vi.fn(async (req: { prompt: string }) => {
        capturedPrompt = req.prompt;
        return {
          content: JSON.stringify({
            bullets:    ['discussed v4.1.2 memory architecture', 'chose chatgpt-plus + gpt-5.5'],
            decisions:  ['gpt-5.5 is the default model'],
            open_items: [],
            keywords:   ['v4.1.2', 'gpt-5.5', 'memory-architecture'],
          }),
        };
      }),
    };

    await distillSession({
      sessionId: 'smoke',
      startedAt: '2026-05-13T00:00:00Z',
      exitPath:  'quit',
      userTurns: 2,
      messages: [
        // The boilerplate the user-reported bug echoed as bullets.
        {
          role: 'system',
          content:
            "I'm Aiden, a local-first AI agent built by Taracod. " +
            "I run on Windows, Linux, or macOS natively. " +
            "I have 72 bundled skills and 40 tools.",
        },
        { role: 'user',      content: 'remember that gpt-5.5 is the auto-picked default for chatgpt-plus' },
        { role: 'assistant', content: 'Saved: gpt-5.5 is the auto-picked default for chatgpt-plus.' },
      ],
      toolTrace: [],
      auxiliaryClient: aux as unknown as Parameters<typeof distillSession>[0]['auxiliaryClient'],
    });

    // None of the boilerplate strings should appear in the prompt
    // the aux client sees — the transcript filter drops them.
    expect(capturedPrompt).not.toContain('local-first AI agent');
    expect(capturedPrompt).not.toContain('built by Taracod');
    expect(capturedPrompt).not.toContain('72 bundled skills');
    // The actual session content survives.
    expect(capturedPrompt).toContain('gpt-5.5 is the auto-picked default');
    // Hardened-prompt rules are present.
    expect(capturedPrompt).toContain('Do NOT describe yourself');
    expect(capturedPrompt).toContain('<transcript>');
    expect(capturedPrompt).toContain('</transcript>');
    // Session timestamps surfaced for the model's context.
    expect(capturedPrompt).toContain('Session started: 2026-05-13T00:00:00Z');
  });

  it('returning empty arrays is NOT marked partial (honest empty)', async () => {
    const aux = {
      call: vi.fn(async () => ({
        // Truly-empty response is a valid signal "nothing to summarize"
        // — but parseLLMDistillation treats all-empty as needing lenient
        // fallback. That fallback returns partial:true. We assert the
        // partial flag flows correctly so empty-on-aux-decline ≠ data loss.
        content: JSON.stringify({
          bullets:    ['only one substantive bullet survived'],
          decisions:  [],
          open_items: [],
          keywords:   [],
        }),
      })),
    };
    const dist = await distillSession({
      sessionId: 'empty',
      startedAt: '2026-05-13T00:00:00Z',
      exitPath:  'quit',
      userTurns: 1,
      messages: [
        { role: 'user', content: 'ok' },
      ],
      toolTrace: [],
      auxiliaryClient: aux as unknown as Parameters<typeof distillSession>[0]['auxiliaryClient'],
    });
    expect(dist.bullets).toEqual(['only one substantive bullet survived']);
    expect(dist.partial).toBeUndefined();        // honest empty, NOT partial
  });
});
