# Hermes — long-term agent quality retrospective

**Source:** Hermes Agent retrospective on long-term agent quality (2026-05-06). Same session as `hermes-architecture-wisdom.md`. Honesty caveat from Hermes:

> "I don't have a live internal BI dashboard here, so I can't give you trustworthy numeric cohorts. What I can give is battle-tested patterns visible in Hermes architecture, fixes, and failure handling."

---

## Hermes transcript (verbatim)

> ⚠ **Transcript paste pending.** CC's message history does not contain the verbatim Hermes prose for this turn — only Shiva's structured summary in the Phase 21 prompt. Paste the transcript inline below and amend or follow-up commit. The "Key points" section below is Shiva's structured capture — faithful summary, not extrapolation.

---

## Key points (structured summary)

### A. Drift
- **In-session:** context saturation, stale assumptions, model shortcutting → **mitigations:** frozen prompt + compression + bounded retry.
- **Cross-session:** stale skills, noisy memory, provider drift → **mitigations:** session boundaries, patching, skill curators.

### B. Eval — three channels
1. **Regression tests** on every previously-bad case.
2. **Trajectory replay** of recorded sessions.
3. **User-reported breakage** funneled into the test corpus.

**Metrics to track:**
- Task success rate.
- Tool-call error rate.
- Partial-run rate.
- Approval abort rate.
- Median turn latency.

Segment all of the above by provider.

### C. Model churn
- Pin defaults; never trust "latest" by name.
- Normalize at the adapter boundary.
- Feature-detect, don't name-faith.
- Family-specific guardrails (Anthropic, OpenAI Codex, Qwen, etc. each get their own quirks file).

### D. Skill rot
- Patch-on-failure (when a skill misfires, fix it that day).
- Periodic verification jobs.
- Each skill carries `version` + `last-verified` metadata.

### E. The 80/20
- **80% of usage:** terminal, file ops, web, session, approvals, model-switching.
- **Lower usage:** specialized plugins, niche integrations.
- Implication: hardening the 80% beats expanding the long tail.

### F. Worst failure modes
1. Confident false completion (model says "done" when it isn't).
2. Malformed tool intent surfacing as plain text (Phase 21 #4 territory).
3. Dangerous command approval bypass.

### G. Emergent behavior
- **Useful:** users chain features into lightweight automations; skill ecosystems become community ops memory.
- **Annoying:** model overfits to recent tool patterns; long sessions encourage "narrative momentum" over re-grounding to facts.

### H. Tipping point — when an agent becomes "indispensable"
Three crossed together:
1. Reliability under failure.
2. Safety UX that isn't unbearable.
3. Session continuity.

**Hermes verbatim closing:** "Single flashy capability rarely tips it. Reliability + trust loop does."
