import { describe, it, expect, afterEach } from 'vitest';
import {
  colors,
  glyphs,
  spacing,
  VERBOSE_MODE_ENV,
  isVerbose,
  TRAIL_PIPE,
} from '../../../cli/v4/design/tokens';

describe('design tokens — v4.8.0 Slice 2', () => {
  // ── Colors ──────────────────────────────────────────────────────────
  it('locks brand orange + the brighter content primary', () => {
    expect(colors.brand.primary).toBe('#FF6B35');
    expect(colors.content.primary).toBe('#e8ebf0');
    expect(colors.content.secondary).toBe('#b8a89a');
  });

  it('exposes the four semantic kinds + new info color', () => {
    expect(colors.semantic.success).toBe('#7fc28b');
    expect(colors.semantic.warn).toBe('#e0a040');
    expect(colors.semantic.error).toBe('#e05a5a');
    expect(colors.semantic.info).toBe('#7da7c7');
  });

  // ── Glyphs ──────────────────────────────────────────────────────────
  it('locks the 6 event-glyph vocabulary used by Phase 2.3+2.4 renderers', () => {
    expect(glyphs.event.running).toBe('⟳');
    expect(glyphs.event.done).toBe('✓');
    expect(glyphs.event.fail).toBe('✗');
    expect(glyphs.event.warning).toBe('⚠');
    expect(glyphs.event.cmd).toBe('▸');
    expect(glyphs.event.file).toBe('📄');
  });

  it('re-exports the trail gutter alongside util glyphs', () => {
    expect(TRAIL_PIPE).toBe('┊');
    expect(glyphs.trail.gutter).toBe('┊');
    expect(glyphs.util.divider).toBe('─');
  });

  // ── Spacing ─────────────────────────────────────────────────────────
  it('locks indent columns + subagent depth multiplier', () => {
    expect(spacing.indent.gutter).toBe(0);
    expect(spacing.indent.glyph).toBe(2);
    expect(spacing.indent.subagentPerDepth).toBe(2);
    expect(spacing.between.groups).toBe(1);
    expect(spacing.between.sections).toBe(2);
  });

  // ── Verbose mode ────────────────────────────────────────────────────
  afterEach(() => {
    delete process.env[VERBOSE_MODE_ENV];
  });

  it('isVerbose() reads the env at call time, defaults to false', () => {
    expect(VERBOSE_MODE_ENV).toBe('AIDEN_VERBOSE');
    expect(isVerbose()).toBe(false);
    process.env[VERBOSE_MODE_ENV] = '1';
    expect(isVerbose()).toBe(true);
    process.env[VERBOSE_MODE_ENV] = 'true';
    expect(isVerbose()).toBe(false);
  });
});
