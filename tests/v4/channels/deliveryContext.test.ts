/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12 DC.1 — DeliveryContext seam.
 *
 * The context is immutable-per-turn: routing authority (platform/chatId/
 * threadId/replyAnchor) is frozen at construction so no downstream code can
 * mutate the target mid-turn. `send()` delegates to the platform driver.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createDeliveryContext,
  type DeliveryBinding,
} from '../../../core/deliveryContext';

function mkBinding(over: Partial<DeliveryBinding> = {}): { binding: DeliveryBinding; deliver: ReturnType<typeof vi.fn> } {
  const deliver = vi.fn(async (kind: string) => ({ ok: true, kind }));
  const binding: DeliveryBinding = {
    driver: { deliver: deliver as any },
    capabilities: { edit: false, chunkLongMessages: true, media: [], voiceBubble: false, reactions: false },
    ...over,
  };
  return { binding, deliver };
}

describe('DC.1 — createDeliveryContext immutability', () => {
  it('carries the routing authority from the inbound message', () => {
    const { binding } = mkBinding();
    const ctx = createDeliveryContext(
      { platform: 'telegram', chatId: 'C1', threadId: 'T1', replyAnchor: 'M9' },
      binding,
    );
    expect(ctx.platform).toBe('telegram');
    expect(ctx.chatId).toBe('C1');
    expect(ctx.threadId).toBe('T1');
    expect(ctx.replyAnchor).toBe('M9');
  });

  it('★ is frozen — routing fields cannot be mutated mid-turn', () => {
    const { binding } = mkBinding();
    const ctx = createDeliveryContext({ platform: 'telegram', chatId: 'C1' }, binding);
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(() => { (ctx as any).chatId = 'HIJACK'; }).toThrow();
    expect(ctx.chatId).toBe('C1');
  });

  it('★ capabilities (and media list) are frozen too', () => {
    const { binding } = mkBinding();
    const ctx = createDeliveryContext({ platform: 'telegram', chatId: 'C1' }, binding);
    expect(Object.isFrozen(ctx.capabilities)).toBe(true);
    expect(() => { (ctx.capabilities.media as string[]).push('photo'); }).toThrow();
    expect(ctx.capabilities.media).toHaveLength(0);
  });

  it('send() delegates to the platform driver (string → {text})', async () => {
    const { binding, deliver } = mkBinding();
    const ctx = createDeliveryContext({ platform: 'telegram', chatId: 'C1' }, binding);
    const r = await ctx.send('final', 'hello world');
    expect(deliver).toHaveBeenCalledWith('final', { text: 'hello world' }, undefined);
    expect(r.ok).toBe(true);
  });

  it('send() passes structured payloads + options through unchanged', async () => {
    const { binding, deliver } = mkBinding();
    const ctx = createDeliveryContext({ platform: 'telegram', chatId: 'C1' }, binding);
    await ctx.send('status', { text: 'ping' }, { silent: true });
    expect(deliver).toHaveBeenCalledWith('status', { text: 'ping' }, { silent: true });
  });

  it('exposes the per-platform firstMessageHint without any platform literal', () => {
    const { binding } = mkBinding({ firstMessageHint: 'HINT' });
    const ctx = createDeliveryContext({ platform: 'telegram', chatId: 'C1' }, binding);
    expect(ctx.firstMessageHint).toBe('HINT');
  });
});
