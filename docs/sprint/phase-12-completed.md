# Phase 12 — Completed

**Date:** 2026-05-04
**Branch:** `v4-rewrite`
**Commits (4 feature + this summary):**
- `8e36506` — feat(v4): PlannerGuard pre-loop tool subset classifier
- `a8684db` — feat(v4): HonestyEnforcement post-loop trace verification
- `47829a9` — feat(v4): SkillTeacher Tier 3 with quality scoring
- `b229938` — feat(v4): wire moat layers into AidenAgent loop
- (this file) — docs(v4): phase 12 summary

## Goal

Build the three differentiating Aiden-only moat layers — PlannerGuard,
HonestyEnforcement, SkillTeacher Tier 3 — and wire them into the
AidenAgent loop. Phase 9 made fabrication harder via guards; Phase 12
makes it visible via Honesty's trace check, and reduces tool-name
hallucinations via PlannerGuard's pre-loop narrowing.

## Task 1 — Inventory

| Item | Source | Strategy |
|---|---|---|
| v3 PlannerGuard | NOT a single file in v3 — pattern lives across `core/agentLoop.ts` (tool category narrowing via `detectToolCategories`) and `core/actionVerbDetector.ts` | Port the intent (keyword → toolset map) but rebuild clean against v4's `ToolHandler.toolset` field. v3 had no LLM-classified mode. |
| v3 honesty / C20 / C21 | Distributed: `core/protectedContext.ts` (MINIMUM_SOUL fallback), `core/aidenPersonality.ts` ("Never claim actions"), `core/agentLoop.ts` (responder injection). No single class. C21 only enforced identity. C20 enforced "no fabricated execution" via prompt — the model usually obeyed but had no trace check. | Phase 12's HonestyEnforcement is the trace-check that v3 never had. The `verified=true/false` fork on memory is the architectural fix for the C20/C21 lying surface. |
| v3 SkillTeacher | `core/skillTeacher.ts` (~456 LOC) — singleton with C18/C12/C7 quality gates, name pollution prevention, destructive-skill rejection, session rate limit. | Port the gating spirit (multi-step + non-trivial + no destructive verbs) but rebuild as a per-instance class. Phase 12 keeps gating simpler (5 calls + 2 toolsets + no errors + opt-out check); Phase 14 layers in v3's name-pollution + destructive checks. |
| Hermes references | None — Hermes has no PlannerGuard/Honesty/SkillTeacher equivalent; it relies on capable models + careful tool design. | Pure Aiden moat; this is what differentiates Aiden from Hermes. |

## Subsystem APIs

### moat/plannerGuard.ts (~330 lines)

```ts
type PlannerGuardMode = 'off' | 'rule_based' | 'llm_classified';
interface PlannerGuardDecision {
  selectedTools: string[];
  excludedTools: string[];
  reason: 'no_filter' | 'rule_match' | 'llm_classification' | 'fallback';
  confidence?: number;
}
class PlannerGuard {
  constructor(registry, mode='rule_based', llmAdapter?);
  decide(userMessage, conversationContext): Promise<PlannerGuardDecision>;
  setMode(mode): void;
  activateToolsets(toolsets: string[]): void;  // skill_view triggers this
  resetActivation(): void;
}
```

Always-on core tools: `skills_list`, `lookup_tool_schema`, `session_search`.
Rule table covers files, web, browser, terminal, memory, skills, sessions,
execute, process. LLM-classified mode parses a JSON-array response,
intersects with the registry, falls back on timeout/malformed/empty.

### moat/honestyEnforcement.ts (~340 lines)

```ts
type HonestyMode = 'off' | 'detect' | 'enforce';
interface HonestyFinding {
  claim: string;
  expectedTool: string | string[];
  found: boolean;
  confidence: number;
  reason?: 'no_tool_call' | 'memory_verified_false' | 'tool_errored';
}
interface HonestyResult {
  passed: boolean;
  findings: HonestyFinding[];
  confidence: number;
  originalResponse: string;
  correctedResponse?: string;
}
class HonestyEnforcement {
  constructor(mode='enforce', llmAdapter?, logger?);
  check(response, messages, toolCallTrace): Promise<HonestyResult>;
}
```

Pattern table maps past-tense action verbs to satisfying tool name(s),
honoring aliases (e.g. `file_patch` and `skill_manage` both satisfy a
"saved" claim). Negation guard prevents "I couldn't save" from triggering.
Memory patterns require `verified === true` on the matching trace entry.
Correction format lists the actual trace summary + each refused claim.

### moat/skillTeacher.ts (~360 lines)

```ts
type SkillTeacherTier = 'off' | 'tier_3_propose' | 'tier_4_auto';
interface SkillProposal {
  proposedName: string;
  description: string;
  toolsUsed: string[];
  exampleSteps: string[];
  trace: Array<{ name; args; result }>;
  confidence: number;
}
class SkillTeacher {
  constructor(skillLoader, skillManager, tier='tier_3_propose', qualityFilePath?, resolveHandler?);
  observeTurn(messages, trace, aborted=false): Promise<SkillProposal | null>;
  handleProposal(proposal, callbacks): Promise<{ created; skillName?; reason? }>;
  trackSkillUsage(name, success): void;
  getSkillQualityScore(name): { successRate; usageCount; flagged };
  flaggedSkillNames(): string[];
}
// helpers
function filterFlaggedSkills<T>(skills, flagged): T[];
function toTeacherTrace(calls, resolveHandler?): SkillTeacherTraceEntry[];
```

Quality persists to `.aiden-skill-quality.json` (configurable). Naming
heuristic: `<toolset-of-most-used-tool>-<3-kebab-words>` from first user
message, after stop-word filtering.

## AidenAgent loop changes

`core/v4/aidenAgent.ts` gained six optional options (`plannerGuard`,
`onPlannerGuardDecision`, `honestyEnforcement`, `skillTeacher`,
`skillTeacherCallbacks`, `resolveVerifiedFlag`, `resolveToolset`) and
three new result fields (`toolCallTrace` always present,
`honestyFindings?`, `skillCreated?`).

Loop structure now:
1. **Pre-loop:** PlannerGuard.decide → narrow `tools` array passed to provider.
2. **Loop body unchanged** — but each tool-call result is appended to
   `toolCallTrace` with `verified` filled by `resolveVerifiedFlag`.
3. **finalize() helper** runs HonestyEnforcement (may rewrite
   `finalContent`), then SkillTeacher.observeTurn → handleProposal.

Layer order is enforced: Honesty rewrites BEFORE SkillTeacher observes,
so anything the user sees has been honesty-checked.

## Test counts

| Bucket | Count |
|---|---|
| New PlannerGuard tests | 15 |
| New HonestyEnforcement tests | 19 |
| New SkillTeacher tests | 14 |
| New AidenAgent moat-wiring tests | 10 |
| New honesty integration tests | 3 |
| **Phase 12 new total** | **61** |
| Cumulative v4 unit + integration | 601 passing + 5 skipped (8 integration tests rate-limited on Groq — pre-existing flakiness, unrelated to Phase 12) |
| Full repo suite | 2009 passing + 5 skipped + 1 todo |

`tsc --noEmit` clean.

## Integration test results (the 3 honesty tests)

Run against real Groq llama-3.3-70b-versatile:

1. **catches fabricated memory_add claim (verified=false)** — PASSED.
   Real LLM said it remembered; trace had `verified: false`; Honesty
   rewrote the response to include "NOT VERIFIED".
2. **catches fabricated file_write claim (no tool fired)** — failed on
   Groq rate limit, not on logic. Same family as the other ~8 v4
   integration tests that pre-existed-fail on rate limits.
3. **passes legitimate claims without rewriting** — failed on Groq
   rate limit, not on logic. Logic is identically tested in
   `aidenAgent.moat.test.ts` test 5.

The unit tests fully cover the same code paths the integration tests
hit; the moat layer's correctness is asserted in 61 deterministic tests.

## Cost spent

No telemetry; rough estimate from token counts: ~$0.02 across all
real-LLM integration test attempts (Groq is cheap; most calls were
rate-limited before completing).

## Graph node count

Before Phase 12: 2342 nodes / 4147 edges (per `GRAPH_REPORT.md`).
After Phase 12: 2413 nodes / 4256 edges / 147 communities.
Delta: +71 nodes, +109 edges, +91 communities. The three moat files
plus their tests added the bulk; new community formation reflects the
moat as a coherent subgraph.

## What's deferred to later phases

| Item | Phase |
|---|---|
| LLM-driven skill description generation | 14 |
| HonestyEnforcement LLM-classified mode enabled by default | 13 |
| Honesty's response rewriting via LLM (not template) | 13 |
| Skill quality dashboard | 14 |
| SkillTeacher prompt UI (TUI surface) | 14 |
| Pro tier gating on Tier 4 (license check) | 18 |
| Multi-turn skill proposals (workflows spanning conversations) | v4.1 |
| Real-time PlannerGuard CLI feedback | 14 |

## What Phase 13 needs

- Wire PlannerGuard into the CLI's session lifecycle (it's currently
  available via `AidenAgentOptions` but no CLI command toggles modes).
- Enable HonestyEnforcement LLM-classified mode (the `llmAdapter`
  argument is wired; just needs a default Gemini Flash / Groq Llama
  3.1 8B aux call, defaults `temperature: 0`, max 200 tokens).
- Integration test fallback: when PlannerGuard returns "no useful
  tools" + LLM says "I can't do that", re-run with the full registry.
