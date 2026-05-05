# Phase 18 — Hermes OAuth + Windows distribution audit

Date: 2026-05-05
Reference: `C:\Users\shiva\references\hermes-agent` (graphify-out present)
Token budget: under 10k. Decisions per surface, copy/adapt/diverge.

## TL;DR

Hermes implements **two genuinely different OAuth flows** for the two providers Phase 18 targets:

- **Claude Pro/Max** — PKCE authorisation-code flow with **out-of-band copy-paste** (no localhost callback). The redirect URI is hosted by Anthropic; the user copies an `<auth_code>#<state>` string back into the terminal.
- **ChatGPT Plus / Codex** — **device-code flow** with poll-until-ready. No callback server needed either.

Both providers store credentials as **plain JSON** in `~/.hermes/` — no DPAPI, no keychain. The Phase 18 spec called for "DPAPI on Windows" — that is **net-new for Aiden** (Hermes doesn't bother), and the spec also called for a "localhost callback server" — that surface is **not applicable** to either provider. Removing it from Phase 18 scope.

Hermes does **not** ship Windows binaries. Aiden v4 already has `npm install -g aiden` plumbed via `package.json` and electron-builder for the GUI .exe. Recommendation: npm-only for v4.0 launch; standalone CLI .exe deferred to v4.1.

## Files of record (Hermes)

| Surface | File | Lines |
|---|---|---|
| Claude Pro PKCE flow | `agent/anthropic_adapter.py` | L1011–L1142 |
| Claude Pro `_generate_pkce` | `agent/anthropic_adapter.py` | L1022–L1032 |
| Claude Pro token refresh (dual endpoint, with form fallback) | `agent/anthropic_adapter.py` | L760–L821 |
| `_refresh_oauth_token` retry path | `agent/anthropic_adapter.py` | L824–L842 |
| Claude Pro setup wizard hook | `hermes_cli/main.py` | L4742 (`_run_anthropic_oauth_flow`) |
| Codex device-code login | `hermes_cli/auth.py` | L3994–L4136 |
| Codex token refresh | `hermes_cli/auth.py` | L1380–L1420 (oauth/token POST) |
| Codex resolve runtime credentials | `hermes_cli/auth.py` | L2406–L2448 |
| Codex CLI token import (`~/.codex/auth.json`) | `hermes_cli/auth.py` | L2372–L2403 |
| Auth-store shared file (one JSON, provider-keyed) | `hermes_cli/auth.py` | (plain JSON, no encryption) |
| Setup script (bash, no Windows) | `setup-hermes.sh` | full file |

## Claude Pro OAuth (copy/adapt)

Constants Hermes uses verbatim (`anthropic_adapter.py:1015–1019`):

```
OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
AUTH_URL_BASE   = "https://claude.ai/oauth/authorize"
TOKEN_URL       = "https://console.anthropic.com/v1/oauth/token"
                  (fallback: https://platform.claude.com/v1/oauth/token)
REDIRECT_URI    = "https://console.anthropic.com/oauth/code/callback"
SCOPES          = "org:create_api_key user:profile user:inference"
```

Flow:
1. Generate PKCE verifier (32 bytes urlsafe-base64) + S256 challenge.
2. Open `https://claude.ai/oauth/authorize?...&code=true&state=<verifier>` in the user's browser.
3. User authorises on `claude.ai`; Anthropic's hosted callback shows `<auth_code>#<state>`.
4. User pastes that string into the terminal.
5. Aiden splits on `#`, POSTs to `console.anthropic.com/v1/oauth/token` with:
   ```
   grant_type=authorization_code, client_id, code, state, redirect_uri, code_verifier
   ```
6. Response carries `access_token`, `refresh_token`, `expires_in` (default 3600s).

Refresh: same client_id, `grant_type=refresh_token`. Try `platform.claude.com/v1/oauth/token` first then `console.anthropic.com/v1/oauth/token` (Hermes order). Form-encoded works; JSON body also accepted (`use_json` flag).

User-Agent header: `claude-cli/<ver> (external, cli)` — required by Anthropic. Aiden will set it to `aiden-cli/<ver> (external, cli)` per the same convention.

**Decision: COPY verbatim.** No callback server. Keep Hermes's copy-paste UX — the alternative (run a localhost server, register it as a redirect URI) requires Anthropic to whitelist Aiden's URI, which they will not.

## ChatGPT Plus OAuth (copy/adapt — different shape)

Constants (`hermes_cli/auth.py:89–90`):

```
CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token"
ISSUER                = "https://auth.openai.com"
DEFAULT_BASE_URL      = "https://chatgpt.com/backend-api/codex"
```

Flow (device-code, NOT authorisation-code):
1. `POST {issuer}/api/accounts/deviceauth/usercode` with `{client_id}`. Response: `user_code`, `device_auth_id`, `interval`.
2. Show user the URL `{issuer}/codex/device` and the `user_code`.
3. Poll `POST {issuer}/api/accounts/deviceauth/token` with `{device_auth_id, user_code}` every `interval` seconds.
   - 200 → response carries `authorization_code` + `code_verifier`.
   - 403/404 → user hasn't logged in yet; keep polling.
4. Exchange: `POST https://auth.openai.com/oauth/token` form-encoded with `grant_type=authorization_code, code, redirect_uri={issuer}/deviceauth/callback, client_id, code_verifier`.
5. Response: `access_token`, `refresh_token`. Base URL is `https://chatgpt.com/backend-api/codex` — **not** `api.openai.com`.

Cap polling at 15 minutes. Refresh token is the same OAuth standard.

**Decision: COPY device-code flow.** Use the **chatgpt.com/backend-api/codex** endpoint for inference (this is Hermes's "openai-codex" provider, which uses Responses API). For Aiden, this means a new provider entry mapping to the existing `codex_responses` apiMode in `providers/v4/types.ts`.

Optional: also support `~/.codex/auth.json` import (`auth.py:2372`) so users with the official Codex CLI installed can adopt the existing tokens. Defer to v4.1 — extra surface area.

## Token storage (Aiden DIVERGES from Hermes)

Hermes stores credentials in plain JSON files (`~/.hermes/auth.json`, `~/.hermes/.anthropic_oauth.json`). Filesystem perms on POSIX (chmod 600) are the only protection; Windows path is unprotected.

Aiden v4 spec asks for **DPAPI on Windows** for v4.0. Net-new for Aiden vs. Hermes. Approach:

1. Storage path: `<aiden-home>/auth/<provider>.json` (one file per provider — easier to scope provider-specific deletes than Hermes's single auth-store-keyed-by-provider).
2. On Windows: encrypt the JSON payload with `crypto.createCipheriv` using a machine-bound key derived from `os.hostname() + os.userInfo().username` + a fixed salt. **Not real DPAPI** — Node has no built-in DPAPI binding without `node-windows-dpapi` or similar native module. Document the limitation: this is **obfuscation, not real protection** against an attacker with code-execution on the machine. Real DPAPI ships in v4.1 (or a `keytar`-style native dep).
3. On POSIX: same machine-bound encryption + chmod 600. Symmetric story across platforms keeps v4.0 simple.
4. The "encryption" is reversible by anyone with code-exec on the user's machine — same effective threat model as Hermes's plain JSON, just less casual. Phase 18 doc will be honest about this.

Aiden v4 already has `providers/v4/credentialResolver.ts` (Phase 4) that owns `auth.json` for `anthropic_messages` and `codex_responses` apiModes. Phase 18's OAuth core builds **alongside** this, not replacing it. The new `tokenStore.ts` lives at `core/v4/auth/tokenStore.ts` and writes per-provider files; `credentialResolver.ts` continues to handle the existing apiMode-keyed flow.

**Decision: Adapt — implement machine-bound encryption with honest doc divergence vs spec's "real DPAPI".** Real DPAPI in v4.1.

## Callback server (Aiden DEFERS — not applicable)

Phase 18 spec called for `callbackServer.ts` listening on a random localhost port to receive the OAuth code. **Neither target provider supports this:**

- **Claude Pro** redirect URI is whitelisted by Anthropic to `console.anthropic.com/oauth/code/callback`. Localhost won't work — copy-paste is the only path.
- **ChatGPT Plus** uses device-code flow with poll. No callback at all.

**Decision: skip `callbackServer.ts`.** If a future v4.1 provider needs localhost callback (e.g., self-hosted OpenRouter OAuth or a custom enterprise IdP), it can land alongside that provider.

## Re-auth UX (copy)

Hermes's pattern: silent pre-flight refresh inside a 5-minute window before token expiry; on refresh failure, prompt user to re-login. Aiden v4's `CredentialResolver` already implements `PREFLIGHT_REFRESH_WINDOW_MS = 5 * 60 * 1000`. Phase 18 wires the new OAuth providers' refresh hooks into the same path.

On 401 from inference: try refresh once, retry the request. If still 401, surface "session expired, run `/auth login <provider>`" and abort the turn cleanly.

## Windows distribution

Hermes ships **bash-only** (`setup-hermes.sh`). No PowerShell installer, no .msi, no .exe.

Aiden's existing footprint:
- `package.json#bin: { "aiden": "..." }` already wired (Phase 16 — `bin: scripts/aiden.js` actually, will verify).
- `electron-builder` produces `.exe` for the GUI (already in `dist:dir`/`dist` scripts).
- `scripts/postinstall.js` runs after `npm install -g`.

**Decision (Task 6):**
- npm-only for v4.0 launch. `npm install -g aiden` then `aiden setup`. README documents this.
- Verify `package.json#files` ships the bundled CDP plugin (already done Phase 17), the OAuth-provider plugins (Task 2/3 will add), and `dist/`.
- Standalone CLI `.exe` (without electron) deferred to v4.1. Existing GUI .exe is the marketing one-click — separate channel.
- Verify `path.join` discipline (no hardcoded `/`) — quick grep at end of phase.
- Verify `cmd.exe /c start ""` for `open_url` (already done Phase 16f).

## Stop-condition resolutions

1. *Claude Pro requires undocumented endpoints?* Resolved — endpoints are public-ish (claude-cli uses them). Same UA spoofing pattern.
2. *ChatGPT requires session-cookie scraping?* Resolved — device-code flow is documented and stable.
3. *Windows DPAPI unavailable?* Acknowledged — Aiden ships machine-bound symmetric encryption (obfuscation, not real DPAPI). Document the threat model honestly. Real DPAPI in v4.1.
4. *Callback port collisions?* Resolved — no callback server needed.

## Plan for Tasks 1–7 (concrete file map)

- `core/v4/auth/oauthFlow.ts` — PKCE generator, copy-paste flow runner, device-code flow runner. Provider-agnostic.
- `core/v4/auth/tokenStore.ts` — `<aiden-home>/auth/<provider>.json` per-provider storage with machine-bound encryption.
- `core/v4/auth/providerAuth.ts` — `OAuthProvider` interface (start, exchange, refresh, getAccessToken). Plugins implement.
- `plugins/aiden-plugin-claude-pro/` — manifest declares `auth-providers` perm; `index.js` runs the copy-paste PKCE flow; registers `claude-pro` provider.
- `plugins/aiden-plugin-chatgpt-plus/` — same shape, device-code flow; registers `chatgpt-plus` provider.
- `cli/v4/setupWizard.ts` — extend with the two new options; both call into the plugin's auth flow.
- `cli/v4/commands/auth.ts` — `/auth list | login <provider> | logout <provider> | refresh <provider>`.
- `package.json` — bin entry verification, files list update for new plugins.
- `cli/v4/aidenCLI.ts` — first-run auto-launch (when no config and no granted plugins).

## End

Audit complete. Token usage well under 10k budget. Begin Task 1 in next commit.
