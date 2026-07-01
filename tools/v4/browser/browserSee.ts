/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/browser/browserSee.ts — `browser_see` (v4.12 B2.2b).
 *
 * Vision escalation: capture an in-memory screenshot of the current page and
 * ask a vision-capable model a focused question; return its text answer.
 *
 * ON-DEMAND, model-invoked ONLY — never wired into any retry path (no auto-loop).
 * Cost-bearing: one vision call per use. Read-only (riskTier safe). When the
 * active model can't see images, returns a clear capability error.
 */
import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { pwScreenshotBuffer } from '../../../core/playwrightBridge';
import { askVision, visionAvailable } from '../../../core/v4/visionClient';
import { withBrowserState } from './_observer';

const _browserSeeTool: ToolHandler = {
  schema: {
    name: 'browser_see',
    description:
      'Look at the current page with vision: screenshots it and asks a vision model your question. Use ONLY when browser_snapshot (the accessibility tree) can\'t answer — e.g. two elements with the same role+name you can\'t tell apart, overlays/popups, canvas, or visual-only state (colours, layout, a visually-disabled control). Cost-bearing: one vision call per use.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'What to determine from the page image.' },
      },
      required: ['question'],
    },
  },
  category: 'browser',
  mutates: false,
  toolset: 'browser',
  riskTier: 'safe',
  async execute(args) {
    const question = String(args.question ?? '').trim();
    if (!question) return { success: false, error: 'No question provided.' };

    const avail = visionAvailable();
    if (!avail.ok) {
      return { success: false, error: `Cannot use browser_see — ${avail.reason}. Switch to a vision-capable model.` };
    }

    const shot = await pwScreenshotBuffer();
    if (!shot.ok || !shot.base64) {
      return { success: false, error: shot.error ?? 'screenshot failed' };
    }

    const r = await askVision({ imageDataUrl: `data:image/png;base64,${shot.base64}`, question });
    if (r.ok) return { success: true, answer: r.text };
    return { success: false, error: r.error };
  },
};

// v4.3 observer HOC — consistent with the other read-only browser tools.
export const browserSeeTool = withBrowserState(_browserSeeTool);
