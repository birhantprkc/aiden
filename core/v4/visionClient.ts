/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/visionClient.ts — v4.12 B2.2a.
 *
 * A process-wide, one-shot vision-call path: hand a screenshot (base64 data URL)
 * + a focused question to a VISION-CAPABLE model and get a text answer back. The
 * active adapter + model are injected at boot via setVisionProvider (the same
 * singleton pattern the browser observer uses).
 *
 * Routing: use the ACTIVE model when it supportsVision (modelCatalog); otherwise
 * return a clear capability error — NO silent re-routing to a different model.
 *
 * B2.2a delivers this path (proven green on its own). B2.2b's browser_see tool is
 * the consumer (screenshot → askVision → text result).
 */
import type { ProviderAdapter } from '../../providers/v4/types';
import { findModel } from '../../providers/v4/modelCatalog';

export interface VisionProvider {
  adapter:    ProviderAdapter;
  providerId: string;
  modelId:    string;
}

let _vision: VisionProvider | null = null;

/** Wire the active adapter/model for vision calls (called at boot). */
export function setVisionProvider(provider: VisionProvider | null): void {
  _vision = provider;
}

/** Is a vision-capable model currently available? */
export function visionAvailable(): { ok: boolean; reason?: string } {
  if (!_vision) return { ok: false, reason: 'no model is configured for vision' };
  const meta = findModel(_vision.providerId, _vision.modelId);
  if (!meta?.supportsVision) {
    return { ok: false, reason: `the current model (${_vision.modelId}) can't see images` };
  }
  return { ok: true };
}

export interface AskVisionResult {
  ok: boolean;
  text?: string;
  error?: string;
}

const DEFAULT_VISION_MAX_TOKENS = 600;

/**
 * One-shot vision call: image + question → text answer. Routes to the active
 * model only when it supportsVision; otherwise a clear capability error.
 */
export async function askVision(opts: {
  imageDataUrl: string;
  question:     string;
  maxTokens?:   number;
}): Promise<AskVisionResult> {
  const v = _vision;
  if (!v) {
    return { ok: false, error: 'No model is available for vision. Switch to a vision-capable model to use this.' };
  }
  const meta = findModel(v.providerId, v.modelId);
  if (!meta?.supportsVision) {
    return {
      ok: false,
      error: `The current model (${v.modelId}) can't see images — switch to a vision-capable model to use this.`,
    };
  }
  try {
    const out = await v.adapter.call({
      messages: [
        { role: 'system', content: 'You are analyzing a screenshot of a web page. Answer the question concisely and factually, based only on what is visible in the image.' },
        { role: 'user', content: opts.question, images: [opts.imageDataUrl] },
      ],
      tools: [],
      maxTokens: opts.maxTokens ?? DEFAULT_VISION_MAX_TOKENS,
    });
    return { ok: true, text: out.content ?? '' };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
