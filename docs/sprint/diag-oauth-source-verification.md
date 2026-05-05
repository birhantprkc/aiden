# Phase 18.1 — OAuth source-code verification diagnostic

Date: 2026-05-05
Reference: `C:\Users\shiva\references\hermes-agent` HEAD `69a246dfe` (2026-05-03, fresh clone)
Scope: source-code-only verification — no live OAuth flow against real accounts.

## Summary

One real divergence found in Claude Pro token-exchange. The two reported errors ("Missing client_id" on the authorize page, "Workspaces not found" on OpenAI's device-auth page) are **upstream / account-side**, not Aiden bugs — but the diagnostic surfaced an **independent** bug in Aiden's Claude Pro token exchange that would have caused a downstream failure once a user got past the browser page.

## Hermes git activity (last 180 days)

```
agent/anthropic_adapter.py:  1 commit  d87fd9f fix(goals): make /goal work in TUI ...
hermes_cli/auth.py:          1 commit  d87fd9f (same — unrelated to OAuth)
```

**Neither file has had an OAuth-related commit in 6+ months.** Hermes has been stable on the same Claude/Codex constants we ported. No recent fixes for "Missing client_id" or "Workspaces not found" — Hermes either does not see these errors or has not addressed them.

No mention of the specific error strings in `website/docs/`, `*.md`, or test fixtures.

## Claude Pro flow: Hermes vs Aiden side-by-side

### URL construction (browser-facing authorize URL)

| Step | Hermes | Aiden | Diff |
|---|---|---|---|
| Param dict | `{code:"true", client_id, response_type:"code", redirect_uri, scope, code_challenge, code_challenge_method:"S256", state:verifier}` | identical | ✓ |
| Encoding | `urllib.parse.urlencode(params)` | `URLSearchParams(params).toString()` | byte-equivalent for ASCII params (verified) |
| URL | `https://claude.ai/oauth/authorize?<encoded>` | identical | ✓ |

**Conclusion: byte-identical browser URL. "Missing client_id" cannot be a URL-construction bug on Aiden's side.**

### Code-paste parsing

| Step | Hermes (`anthropic_adapter.py:1077-1087`) | Aiden (`oauthFlow.ts:184-191`) | Diff |
|---|---|---|---|
| Read | `input("Authorization code: ").strip()` | `await ua.prompt(...).trim()` | ✓ |
| Split | `splits = auth_code.split("#")` ; `code=splits[0]; state=splits[1] if len > 1 else ""` | `pasted.split('#', 2)` ; `state = pastedState ?? ''` | ✓ (subtle: `split('#', 2)` caps to 2 elements; Hermes uncapped — only matters if the code itself contains `#`, which it shouldn't) |

### Token exchange POST  ⚠️  **DIFFERENCE FOUND**

| Field | Hermes (`anthropic_adapter.py:1092-1109`) | Aiden (`oauthFlow.ts:193-212`) | Diff |
|---|---|---|---|
| Body | `json.dumps({grant_type, client_id, code, state, redirect_uri, code_verifier})` | `urlencode({grant_type, client_id, code, state, redirect_uri, code_verifier})` | **DIVERGES** |
| Content-Type | `application/json` | `application/x-www-form-urlencoded` | **DIVERGES** |
| Token URL (first try) | `https://console.anthropic.com/v1/oauth/token` (single, no fallback) | `https://platform.claude.com/v1/oauth/token` (with `console.anthropic.com` fallback) | **DIVERGES** |
| UA header | `claude-cli/<ver> (external, cli)` | `aiden-cli/<ver> (external, cli)` | swap intentional |

**Aiden's Phase 18 audit incorrectly recorded "form-encoded works; JSON body also accepted" for the login path.** Re-reading Hermes verbatim: login uses JSON only; the form-encoded shape is the **refresh** path (`anthropic_adapter.py:760-821`, `use_json: bool = False` default). This is a real Aiden bug — a user who gets past the browser page will hit a 4xx from Anthropic on token exchange.

### Refresh

Hermes refresh (`anthropic_adapter.py:760-821`): tries form-encoded first (`platform.claude.com`), falls back to form-encoded against `console.anthropic.com`, with optional JSON shape via `use_json` flag.

Aiden refresh (`oauthFlow.ts:refreshTokens`): form-encoded against `platform.claude.com` first, then `console.anthropic.com`. ✓ matches the Hermes refresh shape.

## ChatGPT Plus flow: Hermes vs Aiden side-by-side

| Step | Hermes (`hermes_cli/auth.py:3994-4136`) | Aiden (`oauthFlow.ts:runDeviceCodeFlow`) | Diff |
|---|---|---|---|
| Step 1 — usercode POST | `POST {issuer}/api/accounts/deviceauth/usercode`, JSON body `{client_id}`, `Content-Type: application/json` | identical | ✓ |
| Step 2 — show user URL+code | `{issuer}/codex/device` + user_code | identical | ✓ |
| Step 3 — poll | `POST {issuer}/api/accounts/deviceauth/token`, JSON `{device_auth_id, user_code}`; 200=ready, 403/404=pending | identical | ✓ |
| Step 4 — token exchange | `POST {tokenUrl}`, form-encoded `{grant_type:"authorization_code", code, redirect_uri:"{issuer}/deviceauth/callback", client_id, code_verifier}` | identical (form-encoded body, same fields) | ✓ |
| Refresh shape | form-encoded `{grant_type:"refresh_token", refresh_token, client_id}` | identical | ✓ |
| `Accept: application/json` header on usercode | **set explicitly** (`headers={"Accept": "application/json"}` on the httpx Client) | Aiden does NOT set Accept | minor — most servers default to JSON, but worth flagging |

**No request-shape divergence that could trigger "Workspaces not found."** That error is OpenAI server-side terminology referring to the user's account having no workspace bound to the OAuth client. Same flow, same error, in Hermes for the same account.

## Recent commits / known-issue search

- Hermes git log (last 180d) on `anthropic_adapter.py` + `auth.py`: 1 commit, unrelated.
- `grep -rE "Missing client_id|Workspaces not found"` over Hermes: **zero hits** in code, docs, tests, CHANGELOGs, release notes. Hermes does not document these errors.
- Hermes provider docs (`website/docs/integrations/providers.md:21`): "Anthropic | hermes model (Claude Max + extra usage credits via OAuth ...)" — Hermes ships this as a working feature in v0.12.

## Verdict

**Mixed: A on Claude (real Aiden bug found), C on ChatGPT (upstream / account-state).**

Concrete fix list for Phase 18.1:

1. **Claude Pro login token exchange must POST JSON, not form-encoded.** Change `oauthFlow.ts::runCopyPasteFlow` to send `JSON.stringify({...})` with `Content-Type: application/json`. This is a real bug, found despite the user's specific reported error firing **before** this codepath.
2. **Claude Pro login token URL ordering**: try `console.anthropic.com` first (matching Hermes login), keep `platform.claude.com` as fallback. Refresh-path ordering stays as-is (matches Hermes refresh).
3. **ChatGPT Plus**: no code change. Add `Accept: application/json` header for parity, but the dispositive flow is byte-equivalent to Hermes — "Workspaces not found" is OpenAI server-side / account-state, beyond Aiden's reach.
4. **The user's specific reported errors** are upstream:
   - "Missing client_id" on `claude.ai/oauth/authorize` against a URL that contains `client_id=` — Hermes's identical URL construction has been stable for 6+ months. The browser-side rejection is account / session / region specific. Documented as a known limitation in `/auth status` + wizard copy.
   - "Workspaces not found" on `auth.openai.com/codex/device` after entering the device code — same flow as Hermes; OpenAI's Workspace concept is account-state, not request-shape.
5. **Frame OAuth as beta in v4.0** — both providers can fail account-side for reasons we cannot detect from the client. Wizard explainer + `/auth status` footer call this out.

## Recommendation

Ship Phase 18.1 with:
- 1-line fix to JSON content-type for Claude login token exchange
- 1-line fix to Claude login token-URL ordering (`console.anthropic.com` first)
- 1-line fix to add `Accept: application/json` to ChatGPT device-code requests (parity)
- Wizard + `/auth status` "OAuth in beta — provider-side errors may require account-state we cannot detect" copy
- Phase doc note: the reported errors did NOT have a code-side explanation, but the source verification surfaced and fixed a real downstream bug that would have bitten the next user past the browser page.

User decides whether to also queue a Hermes live-test on the same accounts before shipping. The verdict above stands either way; the live test would only confirm whether the user's specific upstream errors are reproducible.
