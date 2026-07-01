/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12 DC.1 — gateway routes the final reply through the DeliveryContext seam.
 *
 * Asserts: the ctx is constructed immutable-per-turn at routeMessage; the final
 * send routes through ctx.send('final') to the correct chat; the per-platform
 * first-message hint replaces the old hardcoded `channel === 'telegram'` branch
 * (the leak is gone from the generic layer); concurrent turns from two chats
 * each get their own ctx (no cross-routing).
 */
import { describe, it, expect, vi } from 'vitest';
import { gateway, type IncomingMessage } from '../../../core/gateway';
import type { DeliveryBinding, DeliveryContext } from '../../../core/deliveryContext';

let userSeq = 0;
const uniqueUser = () => `user_${Date.now()}_${userSeq++}`;

function mkBinding(hint?: string): { binding: DeliveryBinding; sent: Array<{ kind: string; text?: string }> } {
  const sent: Array<{ kind: string; text?: string }> = [];
  const binding: DeliveryBinding = {
    capabilities: { edit: false, chunkLongMessages: true, media: [], voiceBubble: false, reactions: false },
    firstMessageHint: hint,
    driver: {
      deliver: async (kind, payload) => { sent.push({ kind, text: payload.text }); return { ok: true, kind }; },
    },
  };
  return { binding, sent };
}

const msg = (over: Partial<IncomingMessage> = {}): IncomingMessage => ({
  channel: 'telegram', channelId: 'C1', userId: uniqueUser(), text: 'hi', timestamp: 0, ...over,
});

describe('DC.1 — gateway final delivery through the seam', () => {
  it('★ with a binding: constructs ctx, threads it to the processor, delivers final via ctx.send', async () => {
    let seenCtx: DeliveryContext | undefined;
    gateway.setProcessor(async (_m, ctx) => { seenCtx = ctx; return 'RESP'; });
    const { binding, sent } = mkBinding();

    const ret = await gateway.routeMessage(msg({ channelId: 'CHAT-A' }), binding);

    expect(seenCtx).toBeDefined();
    expect(seenCtx!.platform).toBe('telegram');
    expect(seenCtx!.chatId).toBe('CHAT-A');           // frozen routing from the message
    expect(sent).toEqual([{ kind: 'final', text: 'RESP' }]);   // delivered through the seam
    expect(ret).toBe('RESP');
  });

  it('★ appends the per-platform firstMessageHint on the first message (no telegram literal)', async () => {
    gateway.setProcessor(async () => 'RESP');
    const { binding, sent } = mkBinding('HINT-LINE');
    const ret = await gateway.routeMessage(msg(), binding);   // fresh user → messageCount === 1
    expect(ret).toBe('RESP\n\nHINT-LINE');
    expect(sent[0].text).toBe('RESP\n\nHINT-LINE');
  });

  it('★ leak gone: a telegram message with NO binding gets NO hint and NO seam delivery', async () => {
    // Pre-DC.1 the generic gateway hardcoded a telegram tip here. Now the
    // generic layer knows no platform specifics — without a binding, nothing
    // is appended and nothing is delivered (caller owns delivery, as before).
    let seenCtx: DeliveryContext | undefined = {} as any;
    gateway.setProcessor(async (_m, ctx) => { seenCtx = ctx; return 'PLAIN'; });
    const ret = await gateway.routeMessage(msg());   // telegram, first message, but no binding
    expect(seenCtx).toBeUndefined();
    expect(ret).toBe('PLAIN');                       // no tip appended
  });

  it('★ concurrent turns from two chats each route to their own chat (no cross-routing)', async () => {
    // Processor echoes the ctx's chatId; if routing were global, the two
    // interleaved turns would clobber each other's target.
    gateway.setProcessor(async (_m, ctx) => {
      await new Promise((r) => setTimeout(r, 5));
      return `reply-for-${ctx?.chatId}`;
    });
    const a = mkBinding();
    const b = mkBinding();
    const [ra, rb] = await Promise.all([
      gateway.routeMessage(msg({ channelId: 'CHAT-A' }), a.binding),
      gateway.routeMessage(msg({ channelId: 'CHAT-B' }), b.binding),
    ]);
    expect(ra).toBe('reply-for-CHAT-A');
    expect(rb).toBe('reply-for-CHAT-B');
    expect(a.sent).toEqual([{ kind: 'final', text: 'reply-for-CHAT-A' }]);
    expect(b.sent).toEqual([{ kind: 'final', text: 'reply-for-CHAT-B' }]);
  });

  it('processor error → fallback still delivered through the seam', async () => {
    gateway.setProcessor(async () => { throw new Error('boom'); });
    const { binding, sent } = mkBinding();
    const ret = await gateway.routeMessage(msg(), binding);
    expect(ret).toMatch(/went wrong/i);
    expect(sent[0].kind).toBe('final');
    expect(sent[0].text).toMatch(/went wrong/i);
  });
});
