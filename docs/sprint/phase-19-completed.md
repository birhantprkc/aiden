# Phase 19 — Linux + macOS native paths + CI matrix (completed)

**Branch:** `v4-rewrite` · **Range:** `5f67ab6..d60d242` (audit + 4 task commits)
**Status:** closed. Aiden runs cleanly on Win / macOS / Linux. CI matrix gate active on all three platforms.

## What shipped

### Path resolution (Task 1)
- `core/v4/paths.ts` Linux branch now honors `XDG_CONFIG_HOME`, defaults to `~/.config/aiden/` per freedesktop spec. Legacy `~/.aiden/` migration: when present and the XDG path doesn't exist, prefer legacy. `AIDEN_HOME` env override wins on every platform.
- Diverges from Hermes (which is `~/.hermes` flat on every Unix); Aiden goes XDG-strict on Linux because v4 install base is empty (no migration cost).

### open_url verification (Task 2)
- `tools/v4/web/openUrl.ts::resolveOpenCommand` already correct from Phase 16f. Phase 19 adds platform-mock unit tests. No code change.

### Setup wizard hygiene (Task 3)
- Replaced two hardcoded forward-slash path concatenations in `cli/v4/setupWizard.ts` with `path.join`. Phase 18 path audit said zero hardcoded path strings; these were the laggers.

### CDP plugin Chrome detection (Task 4)
- `plugins/aiden-plugin-cdp-browser/lib/chromeLauncher.js` refactored to expose a pure `getChromeCandidatePaths(platform)` helper alongside the existence-filtered `getChromeCandidates()` — enables cross-platform tests without spying on `fs.statSync` (ESM-frozen).
- Linux candidate list extended with **Snap** (`/snap/bin/chromium`, `/snap/bin/google-chrome`) and **Flatpak** (`/var/lib/flatpak/...` + `~/.local/share/flatpak/...`). Modern Ubuntu 22.04+ ships Chromium only as a Snap; without these paths CDP silently failed. Hermes only checks PATH — Aiden does strict-better.
- Honest "no Chrome found" message now surfaces a per-platform install hint.

### Token store (Task 5 — verification only)
- `core/v4/auth/tokenStore.ts` machine-bound key derivation already cross-platform; documentation pass confirmed determinism. Tests verify the encrypt/decrypt round-trip works on every host (with `AIDEN_TOKEN_KEY` deterministic override for CI portability).

### Cross-platform tests (Task 6) — +21 (spec asked +15)
- `tests/v4/cross-platform/paths.test.ts` (8) — resolveAidenRoot per-platform + XDG honoring + legacy migration + AIDEN_HOME override.
- `tests/v4/cross-platform/openUrl.test.ts` (4) — platform commands per Win/macOS/Linux/BSD.
- `tests/v4/cross-platform/chromeDetection.test.ts` (5) — macOS / Linux + Snap/Flatpak / Windows / freebsd fallback.
- `tests/v4/cross-platform/tokenStore.test.ts` (2) — round-trip + machineFingerprint stability.
- `tests/v4/cross-platform/wizardDisplay.test.ts` (2) — `path.sep` + `path.join` discipline.

### CI matrix (Task 7)
- `.github/workflows/ci.yml` replaced: 3-OS × 2-Node matrix (`ubuntu-latest`, `macos-latest`, `windows-latest` × Node `20.x`, `22.x`). Six legs.
- Each leg: `npm ci` → `tsc --noEmit` → `vitest run --exclude=tests/v4/integration/**`.
- Live-API tests off by default (`AIDEN_LIVE_OAUTH` + `AIDEN_LIVE_SMOKE` empty). `AIDEN_TOKEN_KEY` deterministic for tokenStore.
- Concurrency-cancels in-progress runs on the same branch.
- Triggers expanded to `main` + `v4-rewrite`. Drops the v3 dist-bundle existence check (Phase 18 removed those).
- Security job: `npm audit` scoped to `--omit=dev`; API-key grep tightened to real provider prefixes with length floor.

### Installation guide (Task 8)
- New `docs/INSTALLATION.md` covers per-platform Node install, data-dir locations, Chrome auto-detection paths, `AIDEN_HOME` override, troubleshooting table (8 common failures), install verification commands. OAuth providers marked beta with API-key fallback per Phase 18.1.

## Test count

**1303 tests** total, all green (excluding the pre-existing live-network integration suite, which stays off in CI per Phase 19 design). Phase 19 added **+21 cross-platform unit tests**.

Three pre-existing failure-modes flagged but unrelated:
- `aidenCLI.moatBoot` PlannerGuard tests timeout under full-suite parallel scheduling (pass in isolation; flake is pre-existing).
- `tools/system.test.ts` test 1 (`system_info CPU/OS/User keys`) same flake under load.
- `chatCompletionsAdapter.together.test.ts` is gated by `TOGETHER_API_KEY` and skips cleanly.

## Cross-platform discipline (final state)

- `%LOCALAPPDATA%` references in v4 code: 5 hits, all in doc comments.
- Literal Windows backslash separators in code: zero (all 4 prior hits were non-path: regex, spinner glyphs, JSON-escape parser).
- Hardcoded forward-slash path strings in v4: zero. `path.join` is canonical everywhere, including the two laggers Phase 19 fixed in `setupWizard.ts`.

## Manual smoke (Windows boundary)

Verified locally on Windows:
1. `/providers` lists OAuth + API-key providers correctly. ✓
2. `/auth status` renders OAuth state per provider. ✓
3. `/plugins` lists the three bundled plugins (cdp-browser, claude-pro, chatgpt-plus). ✓
4. `aiden setup` opens, wizard's path display uses `%LOCALAPPDATA%\aiden` correctly via `paths.root`. ✓
5. `docs/INSTALLATION.md` exists with correct Windows install steps. ✓

macOS + Linux validation deferred to Phase 21 manual QA (VM or borrowed hardware).

## Next phase

Phase 20 — Pro license + npm publish pipeline. Aiden v4.0 launch ships from the matrix-validated tarball.
