/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/browser/browserUpload.ts — v4.12 B4.2a.
 *
 * Consent-gated file upload. The file-chooser EVENT is recorded passively (never
 * auto-fulfilled); THIS is the explicit, approved action that actually sends the
 * user's file(s) to the page. mutates + dangerous → the executor's B5.2 gate
 * approves it before the filesystem is ever touched.
 */
import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { pwUpload } from '../../../core/playwrightBridge';

const _browserUploadTool: ToolHandler = {
  schema: {
    name: 'browser_upload',
    description:
      'Upload local file(s) to a file <input> on the page. selector = CSS for the input; paths = absolute file path(s). Sends your files to the page — confirm-gated.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector for the <input type="file">.' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Absolute path(s) of the file(s) to upload.' },
      },
      required: ['selector', 'paths'],
    },
  },
  category: 'browser',
  mutates: true,
  toolset: 'browser',
  riskTier: 'dangerous',
  buildPreview(args) {
    const paths = Array.isArray(args.paths) ? (args.paths as string[]) : [];
    return {
      tool: 'browser_upload',
      args,
      riskTier: 'dangerous',
      sideEffects: [{ type: 'browser_action', action: 'upload', target: String(args.selector ?? '') }],
      detectedRisks: [`Uploads ${paths.length} file(s) to the page: ${paths.join(', ')}`],
      summary: `Would upload ${paths.length} file(s) to ${String(args.selector ?? '')}`,
    };
  },
  async execute(args) {
    const selector = String(args.selector ?? '').trim();
    const paths = Array.isArray(args.paths) ? (args.paths as unknown[]).map(String) : [];
    if (!selector || paths.length === 0) return { success: false, error: 'selector and paths are required' };
    const r = await pwUpload(selector, paths);
    return r.ok ? { success: true } : { success: false, error: r.error };
  },
};

export const browserUploadTool = _browserUploadTool;
