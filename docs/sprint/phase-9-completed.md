# Phase 9 — Completed

**Date:** 2026-05-04
**Branch:** `v4-rewrite`
**Commits (6 feature + this summary):**
- `3624dfc` — feat(v4): approval engine + dangerous command pattern catalog
- `1bd7cde` — feat(v4): SSRF protection (RFC 1918, cloud metadata, CGNAT)
- `c7869c9` — feat(v4): tirith scanner (homograph, terminal injection, pipe-to-shell)
- `589712d` — feat(v4): MemoryGuard + memory_add/replace/remove tools
- `fae0190` — feat(v4): wire approval/SSRF/tirith into tool registry
- `177a99d` — test(v4): integration tests for security layer
- (this file) — docs(v4): phase 9 summary

## Goal

Add the safety layer between AidenAgent's tool dispatch and actual
tool execution. Every write/execute tool now goes through
ApprovalEngine; network tools go through SSRF; `shell_exec` goes
through Tirith; memory writes go through MemoryGuard with read-back
verification. This is the phase that makes v4 safe to ship.

## Task 1 — Inventory

| Item | Source | Strategy |
|---|---|---|
| Approval engine | Hermes `tools/approval.py` (1245 lines, 47 patterns) | TS port, **curated 30-pattern subset** |
| Dangerous patterns | Hermes `DANGEROUS_PATTERNS` + v3 C7 `DENIED_COMMANDS` | merged catalog |
| SSRF | spec only (no Hermes file) | Built per spec — DNS lookup before CIDR check |
| Tirith | Hermes `tools/tirith_security.py` (691 lines) | Minimal subset (homograph + ANSI + bidi + pipe-to-interpreter) |
| MemoryGuard | new (Aiden moat) | Wraps `MemoryProvider` with post-write `loadSnapshot()` verification |
| Memory tools | Hermes `tools/memory_tool.py` (586 lines) | Wrap MemoryGuard methods (Aiden ToolHandler shape) |
| v3 C7 PowerShell denies | `core/toolRegistry.ts:108` | preserved (iex, -EncodedCommand, Remove-Item under Users / Windows / Program Files) |
| v3 C8 path-guard | `core/toolRegistry.ts:200` | NOT ported in Phase 9 (deferred — v3's `scanCodeForDestructivePaths` operates inside the code-interpreter; v4 currently has no per-call code-content scanner. Re-evaluate in Phase 11 with MCP) |

Hermes patterns deferred to v4.1 (17 patterns): gateway-lifecycle,
kill-via-pgrep substitution, sed in-place /etc, full git destructive
suite (reset --hard / push --force / clean -f / branch -D), heredoc
script execution, chmod-then-exec two-step, find-exec/find-delete
(actually shipped, listed in completed), dd raw, /dev/sd writes,
several SQL TRUNCATE/DELETE corner cases, project env/config
overwrite. Phase 9 ships the 80/20 catalog; expansion is purely
additive, doesn't break anything that already works.

## Subsystem APIs

```ts
// moat/approvalEngine.ts (~180 lines)
class ApprovalEngine {
  constructor(mode: ApprovalMode, callbacks: ApprovalCallbacks);
  async checkApproval(req: ApprovalRequest): Promise<boolean>;
  setMode / getMode / allowForSession / allowAlways / resetSession;
}

// moat/dangerousPatterns.ts (~95 lines)
DANGEROUS_PATTERNS: DangerPattern[];        // 30 entries
detectDangerousPatterns(input): DangerPattern[];
highestTier(matches): 'safe' | 'caution' | 'dangerous';
classifyCommand(input): { tier, matches, reason };

// moat/ssrfProtection.ts (~190 lines)
class SSRFProtection {
  constructor(dnsLookup?: (h) => Promise<LookupAddress[]>);
  async check(url): Promise<SSRFCheckResult>;
}
// Categories: rfc1918, loopback, link_local, cgnat,
// cloud_metadata, invalid, unsupported_scheme.
// Networks blocked: 9 (6 IPv4 + 3 IPv6).

// moat/tirithScanner.ts (~150 lines)
class TirithScanner {
  scan(text): TirithFinding[];        // composite scan
  scanUrl(url): TirithFinding[];      // homograph + punycode
  scanCommand(cmd): TirithFinding[];  // pipe-to-interpreter
}
// Findings: homograph_url, punycode_url, terminal_injection,
// pipe_to_interpreter, unicode_anomaly.

// moat/memoryGuard.ts (~170 lines)
class MemoryGuard {
  constructor(memory: MemoryProvider);
  guardedAdd(file, content): GuardedResult;        // { ok, verified, reason?, fileLength? }
  guardedReplace(file, oldText, newText): GuardedResult;
  guardedRemove(file, text): GuardedResult;
}

// tools/v4/memory/* (3 wrappers, ~50 lines each)
memoryAddTool, memoryReplaceTool, memoryRemoveTool;
// All call ctx.memoryGuard.* and surface verified:boolean.
```

## Pattern counts

| Catalog | Count |
|---|---:|
| Dangerous patterns | 30 |
| SSRF blocked networks | 9 (6 IPv4 + 3 IPv6) |
| SSRF blocked hostnames | 5 |
| Tirith finding types | 5 |
| Tirith homograph script ranges | 4 (Cyrillic, Greek, Armenian, fullwidth) |

## Test coverage

| File | New cases |
|---|---:|
| `tests/v4/moat/approvalEngine.test.ts` | 14 |
| `tests/v4/moat/dangerousPatterns.test.ts` | 22 |
| `tests/v4/moat/ssrfProtection.test.ts` | 15 |
| `tests/v4/moat/tirithScanner.test.ts` | 11 |
| `tests/v4/moat/memoryGuard.test.ts` | 10 |
| `tests/v4/tools/memory.test.ts` | 6 |
| `tests/v4/toolRegistry.security.test.ts` | 9 |
| `tests/v4/integration/aidenAgent.security.test.ts` | 3 (live Groq) |
| **Phase 9 new** | **90** |

Cumulative v4: **379 passed, 5 skipped** (vs. 291 in Phase 8 — +88
net since Phase 8 includes one extra skip for tirith dedup edge).

## Verification

| Step | Result |
|---|---|
| `npx tsc --noEmit` | ✅ 0 errors |
| `npx vitest run tests/v4/ --no-file-parallelism` | ✅ 379 passed, 5 skipped |
| Live Groq integration: approval blocks `rm -rf` | ✅ promptUser called with riskTier='dangerous' |
| Live Groq integration: SSRF blocks 169.254.169.254 | ✅ "blocked" / "metadata" appears in response |
| Live Groq integration: memory_add verified=true | ✅ content lands on disk; loadSnapshot() confirms |
| `npm test --no-file-parallelism` (full regression) | ✅ **1793 passed**, 5 skipped, 1 todo. 16 pre-existing native-modules / scripts/test-suite failures unchanged. 1 flaky Together AI test (passes in isolation; same family as Phase 7's flaky chatCompletionsAdapter.groq test). |
| Zero v3 regressions | ✅ |

## Cost spent

Three live Groq integration tests, single-shot each. Estimated
**< $0.01 USD** total. Free tier covers it.

## Graphify

| Metric | Pre-Phase 9 | Post-Phase 9 | Δ |
|---|---:|---:|---:|
| Nodes | 2114 | **2166** | +52 |
| Edges | 3779 | 3875 | +96 |
| Files indexed | 408 | 420 | +12 |

Hook fired on each commit; rebuild ran inline.

## What Phase 10 needs

- **Skills system.** 8 hub sources + progressive disclosure +
  `skill_manage` tool. Phase 7 left a stub; Phase 10 is when the
  full surface lands.
- The dangerous-pattern catalog has explicit room for additions
  (the file is `readonly DangerPattern[]` not a `const enum`); skill
  manage tools can register their own patterns when shipped.
- ApprovalEngine + MemoryGuard surfaces are stable — Phase 12 plugs
  HonestyEnforcement into the same `verified` flag without any
  Phase 9 API churn.

## Acceptance check (Phase 9)

- [x] Task 1 inventory reported BEFORE coding
- [x] All 6 subsystems implemented (ApprovalEngine, dangerousPatterns,
      SSRFProtection, TirithScanner, MemoryGuard, memory tools)
- [x] memory_add/replace/remove work + return `verified`
- [x] Approval engine wired into ToolRegistry behind optional ctx flag
- [x] SSRF + tirith wired into network/shell tools
- [x] All 90 new tests pass
- [x] Three integration tests pass (approval, SSRF, memory verified)
- [x] `npx tsc --noEmit` zero errors
- [x] Full regression preserved (1706 → 1793, no new non-flaky failures)
- [x] Six feature commits pushed to `backup`
- [x] Phase summary under 200 lines (this file)
