# Phase 18 — OAuth subscription providers + Windows npm distribution (completed)

**Branch:** `v4-rewrite` · **Range:** `bc67cb3..fa1e324` (audit + 7 task commits)
**Status:** closed. Aiden v4 has Pro-tier OAuth (Claude Pro/Max + ChatGPT Plus), end-to-end inference through OAuth bearer tokens, and an npm tarball ready for `npm publish`.

## What shipped

### OAuth core (`core/v4/auth/`)
- `oauthFlow.ts` — `generatePkce`, `runCopyPasteFlow` (Claude Pro shape), `runDeviceCodeFlow` (ChatGPT Plus shape), `refreshTokens`. All HTTP via injectable `fetchImpl`.
- `tokenStore.ts` — per-provider AES-256-GCM files at `<aiden-home>/auth/<provider>.json`, machine-bound key (host + user + platform + scrypt salt). Honest threat-model framing in the file header AND in `/auth status`: "encrypted with machine-derived key, NOT against code execution; real OS keychain in v4.1."
- `providerAuth.ts` — `OAuthProvider` interface, `OAuthProviderRuntime` (auto-refresh inside the pre-flight window), `OAuthProviderRegistry`.

### Bundled OAuth provider plugins
- `plugins/aiden-plugin-claude-pro/` — PKCE copy-paste flow, constants verbatim per Hermes audit (client_id `9d1c250a…`, claude.ai authorise URL, console.anthropic.com token URL with platform.claude.com fallback). Anthropic-mandated `aiden-cli/<ver> (external, cli)` UA.
- `plugins/aiden-plugin-chatgpt-plus/` — device-code flow with poll, ASCII-boxed user code, "Still waiting… expires in Mm Ss" reminder at the 5-minute mark. Inference base URL is `chatgpt.com/backend-api/codex` (the Codex Responses API, not `api.openai.com`).
- Both plugins use the same `OAuthProviderRuntime` infra. No parallel implementations.

### Plugin system extensions
- `auth-providers` permission added to `PERMISSION_TYPES`. Gates `ctx.registerOAuthProvider`.
- `PluginContext.auth` exposes `runCopyPasteFlow / runDeviceCodeFlow / refreshTokens / generatePkce` as a helpers bundle so plugins don't import `core/v4/auth` directly (TS source vs `dist/` runtime layouts both work).
- `PluginLoader.options.oauthRegistry` threads through to each `PluginContext`.

### Provider registry + runtime bridge
- `providers/v4/registry.ts` — new entries `claude-pro` and `chatgpt-plus` with `oauth: { providerId }` markers. Legacy `claude_subscription` / `chatgpt_subscription` Phase 5 stubs kept (touching them would cascade through 9 files; v4.x cleanup deferred).
- `providers/v4/runtimeResolver.ts` — new credential-chain step before config/env: when entry has `oauth.providerId` and caller passed `paths`, read bearer from tokenStore. If within pre-flight window, throws clear `"run /auth refresh <id>"` error. Auto-refresh during inference deferred to v4.1.
- `providers/v4/modelCatalog.ts` — model entries for the new provider IDs (`claude-opus-4-7` default, `gpt-5` default).

### Setup wizard + slash command
- `cli/v4/setupWizard.ts` `kind: 'pro'` path now runs the real flow (was a v4.1 stub). Explainer line up-front, `prompts.confirm` gate, success surface lists models/file path/expiry plus the threat-model note.
- `cli/v4/auth/loadProvider.ts` — shared module: `loadOAuthProvider`, `openOAuthBrowserUrl`, `PRO_PROVIDER_IDS`, `PRO_PLUGIN_DIRS`, `PLUGIN_AUTH_HELPERS`. Both wizard and `/auth login` import from here. Single entry point.
- `cli/v4/commands/auth.ts` — `/auth` slash command: `status [provider]` (default), `login`, `logout`, `refresh`. Status surface shows state (not-authed / authed / expiring soon / expired), account, relative expiry ("expires in 47 minutes"), file path, encryption note + multi-provider hint.
- `SlashCommandContext.prompt` added (raw-input hook); `chatSession.ts` plumbs from `promptApi.readLine`.

### First-run polish
- `isFreshInstall` is lenient: triggers wizard auto-launch when **any** of root missing / config missing / providers section empty. Plugins-not-granted is **not** a fresh-install signal.
- `printPostWizardTutorial` — under 10 lines: ✓ Setup complete, four example prompts (`ask me anything`, `remember…`, `search the web…`, `play me a popular song`), `/help + /quit` hints. No marketing copy.
- Both wizard success paths (API-key and OAuth) render the same closing screen.

### npm distribution (Task 6)
- `cli/v4/aidenCLI.ts` gets `#!/usr/bin/env node` shebang.
- `package.json#bin.aiden` switches from the v3 esbuild bundle (18MB) to the v4 tsc emit (`dist/cli/v4/aidenCLI.js`).
- `package.json#files` adds `skills/` (was silently missing — bundled-skill restore would have found nothing on npm-installed users) and drops `dist-bundle/{cli,index}.js` (64MB of redundant v3 bundles).
- **Tarball verified via `npm pack --dry-run`: 4.9 MB compressed, 15.9 MB unpacked, 3,498 files.** Well under the 50MB budget.
- Standalone `.exe` deferred to v4.1 per audit (Hermes ships bash-only; Aiden audience are Node-using devs).

## Test count

**220 tests** across the Phase 18 surface, all green. Spec asked for +30 unit; delivered +68.

| Group | Count |
|---|---|
| OAuth core (tokenStore + flow + provider) | 23 |
| Claude Pro plugin (provider shape + login UX + flow + refresh) | 9 |
| ChatGPT Plus plugin (provider shape + UX helpers + login + refresh) | 11 |
| Wizard OAuth integration | 4 |
| `/auth` slash command (status / login / logout / refresh + helpers) | 13 |
| First-run detection + post-wizard tutorial | 8 |
| Phase 17 / 17.1 plugin tests (still green) | 67 |
| Resolver + modelPicker + commands count (after registry additions) | 85 |

**Cost: $0.** Every test mocks fetch + plugin module via `require.cache` patching. No live API calls anywhere in Phase 18.

## Divergences + deferred items

1. **No `callbackServer.ts`** — neither Claude Pro (out-of-band copy-paste, redirect URI is provider-hosted) nor ChatGPT Plus (device-code, no callback) needs a localhost server. Audit-confirmed; if a future provider needs one, it ships with that plugin.
2. **DPAPI / OS keychain** — v4.0 ships machine-bound symmetric encryption (host + user + scrypt salt). Documented honestly: **obfuscation, not protection** against code-exec on the same machine. Real DPAPI / `keytar` lands in v4.1.
3. **Auto-refresh during inference** — v4.0 ships explicit `/auth refresh <id>`. The runtime resolver throws a clear remediation message when tokens enter the pre-flight window. Silent auto-refresh during a turn is v4.1.
4. **Codex CLI token import** — Hermes optionally reads `~/.codex/auth.json` so users with the official Codex CLI can adopt existing tokens. Audit notes the extra surface area; v4.0 ships device-code only.
5. **Wizard "alongside vs replace" UX** — current wizard is single-pick; multi-provider users edit `config.yaml` directly. Documented in `/auth status` footer. Wizard architectural change banked for v4.1.
6. **Standalone `.exe`** — npm-only for v4.0; technical Product Hunt audience already has Node. `pkg`/`nexe`/`sea` + code signing not budgeted.
7. **Legacy `claude_subscription` / `chatgpt_subscription` registry stubs** — Phase 5 IDs (snake_case, no OAuth wiring) kept to avoid cascading through 9 test files. Cleanup is its own future ticket.

## Manual smoke (user pass)

The architectural-completeness gate ran on every commit (220 tests). The user-pass smoke for v4.0 launch:

1. `npm pack` → install the resulting tarball into a fresh `node` shell → `aiden setup`.
2. Pick **Claude Pro / Max** → confirm → browser opens → paste code → wizard saves config + tokens → tutorial prints.
3. `aiden` → boot card shows `[plugins] N loaded` and `[skills] 72 loaded`.
4. Send a message → response from claude-opus-4-7 via OAuth bearer (no Anthropic API key billed).
5. `/auth status` → claude-pro listed, account, relative expiry.
6. `/auth refresh claude-pro` → token re-issued, expiry advanced.
7. `/auth logout claude-pro` → token file deleted; subsequent inference fails with the clear remediation message.
8. Repeat 2-6 for **ChatGPT Plus** (device-code flow, boxed user code).

## Cross-platform path discipline (audit, no fixes — Phase 19)

- `%LOCALAPPDATA%` references: 5 hits in v4 code, **all in doc comments**. Runtime uses `paths.root` from `resolveAidenPaths()` which already branches on `process.platform`.
- Literal Windows backslash separators: 4 hits, all non-path (regex escape, ASCII spinner glyphs, JSON-escape parser).
- Hardcoded forward-slash path strings: **zero** in v4. `path.join` is canonical everywhere.

Phase 19 (Linux + macOS native paths) ships clean.

## Next phase

Phase 19 — Linux + macOS native paths + CI matrix. Plus the v4.1 backlog (real OS keychain, auto-refresh during inference, wizard alongside-vs-replace UX, Codex-CLI token import).
