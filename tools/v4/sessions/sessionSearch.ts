/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/sessions/sessionSearch.ts — `session_search` wrapper.
 *
 * NEW IN V4: surfaces FTS5 keyword search across all stored
 * conversations (Phase 6's `SessionStore`). The agent reaches
 * for this when the user asks "what did we decide about X" and
 * the answer might be in a previous session.
 *
 * Status: PHASE 7. Read-only.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export const sessionSearchTool: ToolHandler = {
  schema: {
    name: 'session_search',
    description:
      'Search past conversation MESSAGES by keyword (FTS5 full-text). ' +
      'Returns matching message SNIPPETS with the session id and timestamp. ' +
      'Use when you need the exact words a past message contained. ' +
      'For topic-level recall of what happened in past sessions (decisions, ' +
      'files touched, open items), call `recall_session` instead.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Keywords or phrase to search for. Also matches tool calls (tool name / command / target), not just prose.',
        },
        limit: {
          type: 'number',
          description: `Maximum number of matches to return. Default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}.`,
        },
        include_tool_output: {
          type: 'boolean',
          description: 'Include noisy tool-OUTPUT messages too. Default false (searches user + assistant messages, plus tool CALLS).',
        },
        order: {
          type: 'string',
          enum: ['relevance', 'newest', 'oldest'],
          description: 'Result ordering. Default "relevance" (BM25).',
        },
      },
      required: ['query'],
    },
  },
  category: 'read',
  mutates: false,
  toolset: 'sessions',
  riskTier: 'safe',   // v4.4 Phase 1
  async execute(args, ctx) {
    const query = String(args.query ?? '').trim();
    if (!query) return { success: false, error: 'No query provided' };
    if (!ctx.sessions) {
      return {
        success: false,
        error: 'Session manager not available in this context',
      };
    }
    const requested = typeof args.limit === 'number' ? args.limit : DEFAULT_LIMIT;
    const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(requested)));
    const order = args.order === 'newest' || args.order === 'oldest' ? args.order : 'relevance';
    const results = ctx.sessions.search(query, {
      limit,
      includeToolOutput: args.include_tool_output === true,
      order,
    });
    return {
      success: true,
      query,
      count: results.length,
      results,
    };
  },
};
