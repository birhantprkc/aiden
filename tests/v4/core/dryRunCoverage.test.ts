/**
 * v4.4 Phase 4 — buildPreview coverage sentinel.
 *
 * Asserts that every registered tool with `mutates: true` defines a
 * `buildPreview` method. Regression guard against adding a new
 * mutating tool without a real preview — `genericPreview` keeps the
 * runtime safe, but we want explicit per-tool previews for the agent
 * + approval UX.
 */
import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../../core/v4/toolRegistry';
import { registerAllTools } from '../../../tools/v4';

function buildRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  registerAllTools(reg);
  return reg;
}

describe('buildPreview coverage (v4.4 Phase 4)', () => {
  const reg = buildRegistry();
  const names = reg.list();

  it('every mutates:true tool defines buildPreview', () => {
    const missing: string[] = [];
    for (const name of names) {
      const h = reg.get(name);
      if (!h) continue;
      if (h.mutates && typeof h.buildPreview !== 'function') {
        missing.push(name);
      }
    }
    expect(missing).toEqual([]);
  });

  it('mutates:false tools may omit buildPreview (no requirement)', () => {
    // Sanity — read-only tools without buildPreview should still
    // register and pass through unchanged via withDryRun.
    const readOnly = names.filter((n) => reg.get(n)?.mutates === false);
    expect(readOnly.length).toBeGreaterThan(20);
  });

  it('count: at least 25 mutating tools have buildPreview', () => {
    const withPreview = names.filter((n) => {
      const h = reg.get(n);
      return h?.mutates && typeof h.buildPreview === 'function';
    });
    expect(withPreview.length).toBeGreaterThanOrEqual(25);
  });
});
