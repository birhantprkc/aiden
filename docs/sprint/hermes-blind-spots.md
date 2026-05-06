# Hermes — blind-spots / "what should I have asked but didn't"

**Source:** Hermes Agent's brutal answer to *"what should I have asked but didn't"* (2026-05-06). Best single piece of feedback in the entire architecture sprint. **Treat as launch-positioning thesis statement.**

---

## Hermes transcript (verbatim)

> ⚠ **Transcript paste pending.** CC's message history does not contain the verbatim Hermes prose for this turn — only Shiva's structured 10-point capture in the Phase 21 prompt. Paste the transcript inline below, replacing this placeholder. The "Ten blind spots" section below is Shiva's structured capture; the **brutal summary at the bottom** is Hermes verbatim per the prompt.

---

## Ten blind spots (structured summary)

1. **"Did it do it?" > "Did it sound smart?"** — Verifiable receipts on every external action. The trace is the product.

2. **Reliability debt compounds faster than feature debt.** — Boring guardrails before sexy features. Every shortcut accrues interest.

3. **Approval UX can quietly kill adoption.** — Need a hard never floor + smart defaults + minimal prompts for routine actions. Too many prompts = abandonment; too few = blast radius.

4. **Model churn will break you unless adapters own the chaos.** — Treat provider APIs as hostile and unstable. The adapter is the moat.

5. **Support load comes from setup ambiguity, not model quality.** — Opinionated default path to first success in **<2 minutes**. Choices later, not at boot.

6. **Session semantics must be explicit.** — Users don't intuit cache/memory/reset. Surface them in the UI as first-class verbs.

7. **Most "AI failures" are product UX failures.** — Surface state transitions plainly. "Now thinking" / "tool running" / "waiting on approval" / "completed" — not silence.

8. **You need incident response BEFORE launch.** — Logs, trace IDs, reproducible bug bundles. The first user bug must be debuggable without asking the user to repro.

9. **You're building a policy engine whether you admit it or not.** — Approvals + blocklists + verifications + permissions = a policy engine. Design it explicitly; otherwise it's distributed everywhere and inconsistent.

10. **The market rewards "boring autonomy."** — Predictable completion of small workflows beats maximal cleverness on demos. The thing that ships.

---

## Brutal summary (Hermes verbatim per the Phase 21 prompt)

> "Aiden will win or lose on **trust-per-turn**, not benchmark IQ. If users can't reliably predict outcomes, recover from failures, and audit what happened, nothing else matters."

---

## Use as launch-positioning thesis

Every v4.0 release-readiness review should ask: **does this change increase or decrease trust-per-turn?** If decrease, defer. If neutral, deprioritize. If increase, ship.
