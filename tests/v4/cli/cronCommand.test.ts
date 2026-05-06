// ============================================================
// DevOS — Autonomous AI Execution System
// Copyright (c) 2026 Shiva Deore. All rights reserved.
// ============================================================
//
// tests/v4/cli/cronCommand.test.ts — /cron slash command:
// quote-aware tokenizer, id/name resolution, list empty state,
// remove confirm prompt, invalid-schedule error.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Writable } from 'node:stream'

// Mock the backend so tests never touch ~/.aiden/cron_jobs.json.
// vi.hoisted lifts the mock factory to the top of the file alongside the
// vi.mock call, so the spies survive vi.mock's hoisting.
const cronMocks = vi.hoisted(() => ({
  createJob:         vi.fn(),
  listJobs:          vi.fn(() => [] as any[]),
  getJob:            vi.fn(),
  pauseJob:          vi.fn(),
  resumeJob:         vi.fn(),
  deleteJob:         vi.fn(),
  triggerJob:        vi.fn(),
  awaitPendingSaves: vi.fn(async () => {}),
}))
vi.mock('../../../core/cronManager', () => cronMocks)

import { Display }      from '../../../cli/v4/display'
import { SkinEngine }   from '../../../cli/v4/skinEngine'
import { CommandRegistry } from '../../../cli/v4/commandRegistry'
import { cron, tokenize, resolveJob } from '../../../cli/v4/commands/cron'

function stripAnsi(s: string): string { return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '') }

function makeCtx(rawArgs: string, over: Record<string, unknown> = {}) {
  const chunks: string[] = []
  const out = new Writable({ write(c, _e, cb) { chunks.push(c.toString()); cb() } }) as any
  return {
    output: () => stripAnsi(chunks.join('')),
    ctx: {
      args: [], rawArgs,
      display:  new Display({ skin: new SkinEngine({ forceMono: true }), stdout: out }),
      registry: new CommandRegistry(),
      ...over,
    },
  }
}

beforeEach(() => {
  for (const m of Object.values(cronMocks)) (m as any).mockReset?.()
  cronMocks.listJobs.mockReturnValue([])
  cronMocks.awaitPendingSaves.mockResolvedValue(undefined)
})

describe('tokenize — quote-aware splitter', () => {
  it('keeps double-quoted strings as a single token', () => {
    expect(tokenize('add hello "every 2 minutes" "say hi"'))
      .toEqual(['add', 'hello', 'every 2 minutes', 'say hi'])
  })
  it('handles cron expressions inside quotes', () => {
    expect(tokenize('add brief "0 9 * * *" "give me NSE top movers"'))
      .toEqual(['add', 'brief', '0 9 * * *', 'give me NSE top movers'])
  })
  it('falls back to whitespace split when unquoted', () => {
    expect(tokenize('list')).toEqual(['list'])
    expect(tokenize('run my-job')).toEqual(['run', 'my-job'])
  })
})

describe('resolveJob — id-prefix and name lookup', () => {
  it('resolves an exact name match', () => {
    cronMocks.listJobs.mockReturnValue([{ id: 'abcd1234', description: 'morning' }])
    expect(resolveJob('morning')?.id).toBe('abcd1234')
  })
  it('resolves a unique id prefix', () => {
    cronMocks.listJobs.mockReturnValue([
      { id: 'abcd1234', description: 'a' },
      { id: 'wxyz9999', description: 'b' },
    ])
    expect(resolveJob('abcd')?.id).toBe('abcd1234')
  })
  it('returns null for an ambiguous id prefix', () => {
    cronMocks.listJobs.mockReturnValue([
      { id: 'abcd1', description: 'a' },
      { id: 'abcd2', description: 'b' },
    ])
    expect(resolveJob('abcd')).toBeNull()
  })
})

describe('/cron list — empty state', () => {
  it('prints the empty-state hint', async () => {
    const { ctx, output } = makeCtx('list')
    await cron.handler(ctx as any)
    expect(output()).toMatch(/No cron jobs/)
  })
})

describe('/cron remove — y/N prompt parsing (24.1c)', () => {
  beforeEach(() => {
    cronMocks.listJobs.mockReturnValue([{ id: 'aaaabbbb', description: 'job' }])
    cronMocks.deleteJob.mockReturnValue(true)
  })

  it('shows a "(y/N)" prompt — disambiguates from the job id', async () => {
    const prompt = vi.fn(async () => 'n')
    const { ctx } = makeCtx('remove job', { prompt })
    await cron.handler(ctx as any)
    expect(prompt).toHaveBeenCalledOnce()
    expect((prompt.mock.calls[0][0] as string)).toMatch(/\(y\/N\)/)
  })

  it('typing the job id ("1") is treated as cancel, not delete', async () => {
    const prompt = vi.fn(async () => '1')
    const { ctx, output } = makeCtx('remove job', { prompt })
    await cron.handler(ctx as any)
    expect(cronMocks.deleteJob).not.toHaveBeenCalled()
    expect(output()).toMatch(/Cancelled/)
  })

  it.each([['y'], ['Y'], ['yes'], ['YES']])('typing %j confirms', async (answer) => {
    const prompt = vi.fn(async () => answer)
    const { ctx } = makeCtx('remove job', { prompt })
    await cron.handler(ctx as any)
    expect(cronMocks.deleteJob).toHaveBeenCalledWith('aaaabbbb')
  })

  it('typing nothing (empty) cancels', async () => {
    const prompt = vi.fn(async () => '')
    const { ctx, output } = makeCtx('remove job', { prompt })
    await cron.handler(ctx as any)
    expect(cronMocks.deleteJob).not.toHaveBeenCalled()
    expect(output()).toMatch(/Cancelled/)
  })

  it('falls back to ctx.confirm when ctx.prompt is not wired', async () => {
    const confirm = vi.fn(async () => true)
    const { ctx } = makeCtx('remove job', { confirm })
    await cron.handler(ctx as any)
    expect(confirm).toHaveBeenCalledOnce()
    expect(cronMocks.deleteJob).toHaveBeenCalledWith('aaaabbbb')
  })
})

describe('/cron add — surfaces parser errors', () => {
  it('reports the parser error message verbatim', async () => {
    cronMocks.createJob.mockImplementation(() => { throw new Error('Cannot parse schedule "garbage"') })
    const { ctx, output } = makeCtx('add my-job garbage "do thing"')
    await cron.handler(ctx as any)
    expect(output()).toMatch(/Cannot parse schedule/)
    expect(cronMocks.createJob).toHaveBeenCalled()
  })
  it('rejects names with whitespace / invalid chars before calling createJob', async () => {
    const { ctx, output } = makeCtx('add "bad name" "every 2m" "do thing"')
    await cron.handler(ctx as any)
    expect(output()).toMatch(/Invalid name/)
    expect(cronMocks.createJob).not.toHaveBeenCalled()
  })
})
