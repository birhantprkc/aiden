/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/web/webSearch.ts — `web_search` wrapper.
 *
 * Delegates to the v3 `reliableWebSearch` fallback chain
 * (SearxNG → Brave → DuckDuckGo → Wikipedia) — the chain is
 * battle-tested and the moat we're keeping verbatim.
 *
 * Status: PHASE 7. Read-only.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { reliableWebSearch } from '../../../core/webSearch';

export const webSearchTool: ToolHandler = {
  schema: {
    name: 'web_search',
    description:
      'Search the web for current information. Returns a synthesised text answer drawn from search snippets, Wikipedia summaries, and (when available) full page content from the top results.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query.',
        },
      },
      required: ['query'],
    },
  },
  category: 'network',
  mutates: false,
  toolset: 'web',
  riskTier: 'safe',   // v4.4 Phase 1
  async execute(args) {
    const query = String(args.query ?? '').trim();
    if (!query) {
      return { success: false, error: 'No query provided' };
    }
    const result = await reliableWebSearch(query);
    // A search that RAN but returned nothing is not a silent success. An empty
    // result must be an honest negative so the agent never proceeds as though it
    // learned something. (The verifier flags empty as `low_signal` but `ok:true`,
    // which nothing downstream treats as a non-result for a read-only tool — so
    // the honest signal has to originate here, at the tool boundary.)
    if (result.success && !String(result.output ?? '').trim()) {
      return {
        success: false,
        error:
          `web_search returned no results for "${query}" — the search ran but ` +
          `found nothing. Try a different query, or web_fetch a known URL.`,
      };
    }
    return result;
  },
};
