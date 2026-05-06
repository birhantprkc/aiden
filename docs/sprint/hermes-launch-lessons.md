# Hermes — launch & adoption retrospective

**Source:** Hermes Agent v0.12.0 retrospective on launch & adoption (2026-05-06). Captured via direct chat in WSL Ubuntu. Honesty caveat from Hermes:

> "I don't have internal Hermes analytics dashboards in this environment (no true user-count funnel/retention dataset), so I can't claim hard numbers. I can infer from repo evidence (release cadence, recurring fixes, docs emphasis, support surfaces)."

Same session as `hermes-architecture-wisdom.md` (continuation past 90.9K context).

---

## Hermes transcript (verbatim)

> ⚠ **Transcript paste pending.** CC's message history does not contain the verbatim Hermes prose for this turn — only Shiva's structured summary in the Phase 21 prompt. Paste the transcript inline below, replacing this placeholder, then amend or follow-up commit. Until then, the "Key points" section below stands as a faithful structured summary of the session — Shiva's words, not extrapolation.

---

## Key points (structured summary)

### A. Positioning — what worked vs failed
- **Worked:** "one agent everywhere," bring-your-own-model, tooling depth + reliability.
- **Failed:** anything that promised general intelligence over specific reliability.

### B. Audience
- Power users and developers.
- Automation-heavy gateway users.
- Messaging-first surprise vector (chat-driven adoption).

### C. Onboarding drop-off
- Provider/auth setup complexity is the #1 funnel killer.
- Too many choices at first run.
- Expectations mismatch (users expect more than the model delivers on turn 1).
- **Hard rule:** force time-to-first-win in **under 2 minutes**.

### D. What kills retention
- Unreliable execution trace.
- Slow or fragile in long sessions.
- "Almost works" — partial completion without honest framing.
- Excessive approval prompts.

### E. Pricing signals
- **Will pay for:** reliability/uptime guarantees, team/audit features, premium integrations.
- **Won't pay for:** cosmetic personality, raw "more prompts/quota."

### F. Support burden
- Auth/provider confusion.
- Platform-specific gateway issues.
- "Why didn't my change apply?" (cache invalidation visibility).

### G. Competitive truth — Aiden differentiation candidates
- Native Windows excellence (no WSL ceremony).
- Stronger honesty guarantees (verifiable trace, MemoryGuard, HonestyEnforcement).
- Lower-friction Pro tier.
- Deterministic approval rules (no surprise auto-allows).

### H. First 1000 users — 5 channels in priority order
1. Founder + dev network (warm intros).
2. Niche Discord/Slack communities.
3. Twitter/X demo threads (end-to-end recordings, not screenshots).
4. Product Hunt for one spike day.
5. HN/Reddit if the technical depth is presentable to those audiences.

### Closing positioning advice (from Hermes)
- Lead with one hard promise: **production-trustworthy Windows-native agent CLI.**
- Demo 3 workflows end-to-end **with failure recovery**.
- Publish known limitations upfront.
- Track funnel from day 1.
