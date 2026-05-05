# Phase 18.1 — OAuth provider verification diagnostic

Date: 2026-05-05
Reference: `C:\Users\shiva\references\hermes-agent` (graphify-out present)

## Reported errors (manual smoke)

1. **Claude Pro** — opening the authorise URL in the browser returns `Missing client_id parameter` even though the URL contains `client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e`.
2. **ChatGPT Plus** — the device code displays correctly; entering it on `auth.openai.com/codex/device` returns `Workspaces not found in client auth session`.

## Hermes constants (current working copy)

Sourced via graphify navigation + targeted reads of the canonical files:

| Field | File:line | Value |
|---|---|---|
| Claude `client_id` | `agent/anthropic_adapter.py:1015` | `9d1c250a-e61b-44d9-88ed-5944d1962f5e` |
| Claude authorise URL (browser) | `agent/anthropic_adapter.py:1054` | `https://claude.ai/oauth/authorize` |
| Claude token URL (login exchange) | `agent/anthropic_adapter.py:1016, 1102` | `https://console.anthropic.com/v1/oauth/token` (single, no fallback) |
| Claude token URL (refresh) | `agent/anthropic_adapter.py:785–788` | tries `https://platform.claude.com/v1/oauth/token` first, falls back to `https://console.anthropic.com/v1/oauth/token` |
| Claude redirect URI | `agent/anthropic_adapter.py:1017` | `https://console.anthropic.com/oauth/code/callback` |
| Claude scopes | `agent/anthropic_adapter.py:1018` | `org:create_api_key user:profile user:inference` |
| Claude UA header | `agent/anthropic_adapter.py:1106` | `claude-cli/<ver> (external, cli)` |
| ChatGPT (Codex) `client_id` | `hermes_cli/auth.py:89` | `app_EMoamEEZ73f0CkXaXp7hrann` |
| ChatGPT issuer | `hermes_cli/auth.py:3998` | `https://auth.openai.com` |
| ChatGPT user-verification URL | `hermes_cli/auth.py:4035` | `https://auth.openai.com/codex/device` |
| ChatGPT token URL | `hermes_cli/auth.py:90, 4089` | `https://auth.openai.com/oauth/token` |

## Aiden constants (what we ported)

| Field | File | Value | Match? |
|---|---|---|---|
| Claude `client_id` | `plugins/aiden-plugin-claude-pro/index.js` | `9d1c250a-e61b-44d9-88ed-5944d1962f5e` | ✓ |
| Claude authorise URL | same | `https://claude.ai/oauth/authorize` | ✓ |
| Claude token URL (login + refresh) | same | `platform.claude.com/v1/oauth/token` first; `console.anthropic.com/v1/oauth/token` fallback | **DIFF on login order** |
| Claude redirect URI | same | `https://console.anthropic.com/oauth/code/callback` | ✓ |
| Claude scopes | same | `org:create_api_key user:profile user:inference` | ✓ |
| Claude UA header | same | `aiden-cli/<ver> (external, cli)` | ✓ (UA name swap, structure matches) |
| ChatGPT `client_id` | `plugins/aiden-plugin-chatgpt-plus/index.js` | `app_EMoamEEZ73f0CkXaXp7hrann` | ✓ |
| ChatGPT issuer | same | `https://auth.openai.com` | ✓ |
| ChatGPT user-verification URL | same | `https://auth.openai.com/codex/device` (default in `oauthFlow.ts`) | ✓ |
| ChatGPT token URL | same | `https://auth.openai.com/oauth/token` | ✓ |
| ChatGPT inference base URL | same | `https://chatgpt.com/backend-api/codex` | ✓ |

## Match analysis

**The browser-facing authorise URL is byte-identical between Hermes and Aiden.** Both ship the same `client_id`, same param order via standard URL encoding (Hermes uses `urllib.parse.urlencode`, Aiden uses `URLSearchParams`), same scopes, same redirect URI. Anthropic's page rendering "Missing client_id parameter" against a URL that demonstrably contains `client_id=...` cannot be a parameter-construction bug on the Aiden side — Hermes would hit the identical issue.

**One minor divergence flagged:** Aiden tries `platform.claude.com` first for the LOGIN token exchange; Hermes uses `console.anthropic.com` only for login (and `platform.claude.com` first for refresh). This **cannot cause the reported "Missing client_id" error** because the token URL is hit AFTER the browser flow returns the auth code — the user never gets that far. Worth aligning to Hermes ordering anyway for forward-compat.

**ChatGPT "Workspaces not found in client auth session"** is OpenAI-server-side terminology referring to their multi-org Workspace concept. The flow code never sets workspace context; this is account state OpenAI inspects after the user enters the device code. Aiden's port matches Hermes verbatim; if the error fires here it fires identically in Hermes for the same account.

## Hermes live-test result

**Not run from this sandbox** (out of scope — sandboxed CLI cannot install / execute Hermes against the user's live Anthropic and OpenAI accounts). The dispositive disambiguation step is for the user to run the same flows under Hermes locally:

```bash
# In a separate shell, with the same user account active:
cd C:\Users\shiva\references\hermes-agent
pip install -e .  # if not already installed
hermes auth claude    # → does it hit "Missing client_id" too?
hermes auth codex     # → does it hit "Workspaces not found" too?
```

| Hermes result | Conclusion |
|---|---|
| Both flows fail with the same errors | **upstream provider issue** — Anthropic's OAuth backend and/or OpenAI's device-auth backend changed behaviour or are account-specific. Beyond Aiden/Hermes shared control. |
| Both flows succeed | Aiden has a subtle bug we missed despite constants matching — most likely candidates: URL encoding edge case, request-body shape on the token POST, missing header that Hermes happens to send. Re-audit network round-trips. |
| Mixed (one works, one fails) | Provider-specific. Treat the working one as the v4.0 path and document the broken one as a known limitation. |

## Recommended action

**(B) Most likely: upstream provider issue. Ship v4.0 with documented limitation; OAuth providers marked "beta — may require account state we cannot detect." Constants match Hermes verbatim; the dispositive step is a Hermes live test on the same accounts.**

Concretely, conditional on the user's Hermes test:

- **If Hermes also fails on both** → Phase 18.1 ships:
  1. A one-line fix to align the Claude Pro LOGIN token URL ordering to Hermes (`console.anthropic.com` first, `platform.claude.com` fallback) — defensive only, not the cause of the reported errors.
  2. A short note in `/auth status` and the wizard's OAuth confirm step: "OAuth subscription auth is in beta — if your provider returns an unexpected error, it may be account-state-specific. Use API-key providers as a fallback."
  3. The phase-18 doc updated with the Hermes live-test result and a pointer to this diag doc.

- **If Hermes succeeds where Aiden fails** → re-open OAuth flow code review; queue Phase 18.2 to chase the divergence with packet captures.

- **If user's Hermes test is mixed** → ship the working provider, mark the failing one as "v4.1 — provider-side gap, awaiting <Anthropic|OpenAI> support response."

## What this diagnostic does NOT do

- Does not change OAuth code. Constants and flow match Hermes — there is nothing to fix without first ruling out upstream.
- Does not "guess and ship" different constants. Anthropic and OpenAI's OAuth client IDs are not arbitrary — using a different value gets the request rejected at a different layer.
- Does not run Hermes against live provider accounts from inside Aiden's sandbox.

## Next step (user)

1. Run `hermes auth claude` and `hermes auth codex` (or equivalents) on the same machine + accounts that hit the reported errors.
2. Report back: did Hermes hit identical errors? Different errors? Or work cleanly?
3. Based on result, pick (B) / re-open flow review / ship working provider only — per the table above.
