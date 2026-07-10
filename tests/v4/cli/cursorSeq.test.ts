import { describe, it, expect } from 'vitest';
import { clearLinesUpSeq } from '../../../cli/v4/display/cursorSeq';

/**
 * A tiny CONTENT-tracking VT: a grid of row strings, a cursor, and the handful
 * of ops the streaming re-render emits (CPL/CUU/CUD/CUP, ED, EL, text, LF/CR).
 * Unlike a "touched rows" tracker, it keeps each row's text so a test can assert
 * that a line parked BELOW the stream's footprint still holds its content after
 * the re-render erase.
 */
class VT {
  cursor = 0;
  private col = 0;
  readonly rows: string[];
  constructor(readonly height: number) { this.rows = Array.from({ length: height }, () => ''); }

  private clearRow(r: number): void { if (r >= 0 && r < this.height) this.rows[r] = ''; }

  feed(s: string): void {
    for (let i = 0; i < s.length; i += 1) {
      const ch = s[i];
      if (ch === '\x1b' && s[i + 1] === '[') {
        let j = i + 2; let p = '';
        while (j < s.length && /[0-9;]/.test(s[j]!)) { p += s[j]; j += 1; }
        const fin = s[j]; i = j;
        const n = parseInt(p.split(';')[0] || '0', 10);
        switch (fin) {
          case 'F': this.cursor = Math.max(0, this.cursor - Math.max(1, n)); this.col = 0; break;
          case 'A': this.cursor = Math.max(0, this.cursor - Math.max(1, n)); break;
          case 'B': this.cursor = Math.min(this.height - 1, this.cursor + Math.max(1, n)); break;
          case 'H': case 'f': {
            const parts = p.split(';');
            this.cursor = Math.max(0, Math.min(this.height - 1, (parseInt(parts[0] || '1', 10)) - 1));
            this.col = Math.max(0, (parseInt(parts[1] || '1', 10)) - 1);
            break;
          }
          case 'J':
            if (p === '2') for (let r = 0; r < this.height; r += 1) this.clearRow(r);
            else if (p === '1') for (let r = 0; r <= this.cursor; r += 1) this.clearRow(r);
            else for (let r = this.cursor; r < this.height; r += 1) this.clearRow(r);  // ED0 → end of screen
            break;
          case 'K': this.clearRow(this.cursor); break;
          default: break;   // SGR etc.
        }
        continue;
      }
      if (ch === '\n') { this.cursor = Math.min(this.height - 1, this.cursor + 1); this.col = 0; }
      else if (ch === '\r') { this.col = 0; }
      else {
        const row = this.rows[this.cursor] ?? '';
        this.rows[this.cursor] = row.slice(0, this.col) + ch + row.slice(this.col + 1);
        this.col += 1;
      }
    }
  }
}

/** Set up a 24-row screen: a 3-line stream block at rows 10-12, a sentinel
 *  parked at row 14 (below the block), cursor at row 13 (block-end + 1, exactly
 *  where the stream tail leaves it before the re-render fires). */
function screenWithParkedLine(): VT {
  const vt = new VT(24);
  vt.feed('\x1b[11;1Hblock0');          // row 10
  vt.feed('\x1b[12;1Hblock1');          // row 11
  vt.feed('\x1b[13;1Hblock2');          // row 12
  vt.feed('\x1b[15;1HSENTINEL_BELOW');  // row 14 — parked below the block
  vt.feed('\x1b[14;1H');                // cursor → row 13 (block-end + 1)
  return vt;
}

describe('clearLinesUpSeq — bounded rerender erase', () => {
  it('never emits \\x1b[J and clears exactly n lines', () => {
    const seq = clearLinesUpSeq(3);
    expect(seq).not.toMatch(/\x1b\[[0-2]?J/);
    expect(seq.startsWith('\x1b[3F')).toBe(true);
    expect((seq.match(/\x1b\[2K/g) || []).length).toBe(3);
    expect(clearLinesUpSeq(1)).toBe('\x1b[1F\x1b[2K');
    expect(clearLinesUpSeq(0)).toBe('');
  });

  it('TEETH: a line parked below the stream footprint SURVIVES the re-render', () => {
    const vt = screenWithParkedLine();
    vt.feed(clearLinesUpSeq(3));                     // the bounded eraser (N = 3 block lines)
    expect(vt.rows[14]).toBe('SENTINEL_BELOW');      // parked line intact
    expect(vt.rows[10]).toBe('');                    // block line 0 cleared
    expect(vt.rows[12]).toBe('');                    // block line 2 cleared
    expect(vt.cursor).toBe(10);                      // left at block start for the reprint
  });

  it('CONTROL: the OLD `\\x1b[NF\\x1b[J` erase WIPES the parked line (the check can say no)', () => {
    const vt = screenWithParkedLine();
    vt.feed('\x1b[3F\x1b[J');                         // pre-fix: up 3, erase-to-end-of-screen
    expect(vt.rows[14]).toBe('');                    // SENTINEL_BELOW erased — the hazard
  });
});
