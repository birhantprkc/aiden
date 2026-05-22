/**
 * tests/v4/identity/ids.test.ts — v4.9.0 Slice 4.
 *
 * UUIDv7 layout, prefix typing, parseId roundtrip.
 */
import { describe, it, expect } from 'vitest';
import {
  uuidv7Bytes,
  newUuidV7,
  newUuidV7Compact,
  newDaemonId,
  newIncarnationId,
  newRunId,
  newTriggerId,
  newTraceId,
  newSpanId,
  newRequestId,
  newToolCallId,
  newMemoryId,
  newHookId,
  parseId,
  isIdWithPrefix,
  ID_PREFIXES,
} from '../../../core/v4/identity/ids';

describe('UUIDv7 byte layout — v4.9.0 Slice 4', () => {
  it('top 48 bits encode the supplied timestamp (big-endian)', () => {
    const ts = 1734570123456; // 2024-12-19 ish
    const buf = uuidv7Bytes(ts);
    const decoded =
      (buf[0] * 2 ** 40) +
      (buf[1] * 2 ** 32) +
      (buf[2] * 2 ** 24) +
      (buf[3] * 2 ** 16) +
      (buf[4] * 2 ** 8)  +
       buf[5];
    expect(decoded).toBe(ts);
  });

  it('version nibble is 0b0111 (UUIDv7)', () => {
    const buf = uuidv7Bytes();
    expect((buf[6] >> 4) & 0x0f).toBe(0x7);
  });

  it('variant bits are 0b10 (RFC 4122)', () => {
    const buf = uuidv7Bytes();
    expect((buf[8] >> 6) & 0x03).toBe(0x2);
  });

  it('rejects invalid timestamps', () => {
    expect(() => uuidv7Bytes(-1)).toThrow(/invalid timestamp/);
    expect(() => uuidv7Bytes(Number.NaN)).toThrow(/invalid timestamp/);
  });

  it('canonical UUID has 4 dashes in the expected positions', () => {
    const s = newUuidV7();
    expect(s).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('compact UUID is 32 lowercase hex chars', () => {
    expect(newUuidV7Compact()).toMatch(/^[0-9a-f]{32}$/);
  });

  it('two consecutive UUIDv7s sort in time order (within the same ms)', () => {
    // Same ms ⇒ may sort either way (random tail). Test that across many
    // calls with a 2ms gap, the second is strictly greater.
    const a = newUuidV7Compact();
    const start = Date.now();
    while (Date.now() - start < 3) { /* busy-wait 3ms */ }
    const b = newUuidV7Compact();
    expect(a < b).toBe(true);
  });
});

describe('Typed prefix helpers — v4.9.0 Slice 4', () => {
  it('emits the expected prefix per helper', () => {
    expect(newDaemonId()).toMatch(/^dmn_/);
    expect(newIncarnationId()).toMatch(/^inc_/);
    expect(newRunId()).toMatch(/^run_/);
    expect(newTriggerId()).toMatch(/^trg_/);
    expect(newTraceId()).toMatch(/^trc_/);
    expect(newSpanId()).toMatch(/^spn_/);
    expect(newRequestId()).toMatch(/^req_/);
    expect(newToolCallId()).toMatch(/^tool_/);
    expect(newMemoryId()).toMatch(/^mem_/);
    expect(newHookId()).toMatch(/^hook_/);
  });

  it('every prefix matches the registered set', () => {
    const sample = [newDaemonId(), newIncarnationId(), newRunId(), newHookId()];
    for (const id of sample) {
      const prefix = id.split('_')[0];
      expect(ID_PREFIXES).toContain(prefix);
    }
  });
});

describe('parseId — v4.9.0 Slice 4', () => {
  it('roundtrips a typed id', () => {
    const id = newRunId();
    const parsed = parseId(id);
    expect(parsed).not.toBeNull();
    expect(parsed!.prefix).toBe('run');
    expect(parsed!.uuid).toMatch(/^[0-9a-f]{32}$/);
  });

  it('accepts canonical (dashed) UUID payloads', () => {
    const dashed = `dmn_${newUuidV7()}`;
    const parsed = parseId(dashed);
    expect(parsed?.prefix).toBe('dmn');
    expect(parsed?.uuid.length).toBe(32);
    expect(parsed?.uuid.includes('-')).toBe(false);
  });

  it('returns null for unknown prefix', () => {
    expect(parseId('xyz_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBeNull();
  });

  it('returns null for malformed payload', () => {
    expect(parseId('run_short')).toBeNull();
    expect(parseId('run_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz')).toBeNull();
    expect(parseId('run_')).toBeNull();
    expect(parseId('runid_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBeNull(); // wrong prefix
  });

  it('returns null for non-string / empty input', () => {
    expect(parseId('')).toBeNull();
    expect(parseId(undefined as unknown as string)).toBeNull();
    expect(parseId(null as unknown as string)).toBeNull();
  });

  it('isIdWithPrefix narrows correctly', () => {
    const r = newRunId();
    expect(isIdWithPrefix(r, 'run')).toBe(true);
    expect(isIdWithPrefix(r, 'dmn')).toBe(false);
    expect(isIdWithPrefix('garbage', 'run')).toBe(false);
  });
});
