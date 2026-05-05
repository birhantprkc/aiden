# Phase 17 — Plugin system (completed)

**Branch:** `v4-rewrite` · **Range:** `1b09aeb..791d87c` (audit + 5 task commits)  
**Status:** closed. Aiden v4 has plugin architecture, working media-playback foundation, CDP attach surface for v4.1.

## What shipped

### Module set (`core/v4/plugins/`)
- `pluginManifest.ts` — `plugin.json` schema, single-pass multi-error validator, `MANIFEST_VERSION = 1`, `PERMISSION_TYPES`, `LIFECYCLE_HOOKS`.
- `pluginContext.ts` — facade for `register(ctx)`. Enforces declared-equals-actual at `registerTool` time. In `pending-grant` state, wraps each handler with a refusal that points at `/plugins grant <name>`.
- `pluginRegistry.ts` — tracks `LoadedPlugin` records with 7 lifecycle states.
- `pluginLoader.ts` — discovers from bundled-dir + user-dir, dynamic `import()`, per-plugin try/catch isolation. Hook firing wraps each callback so misbehaving plugins can't crash the agent.
- `pluginPermissions.ts` — granted-file I/O, `evaluatePermissionState(manifest)` returning `granted` / `pending-grant` / `suspended`, `formatInstallSummary`, `buildPermissionChecker`.
- `pluginBundledRestore.ts` — for future dep-free plugins; not invoked at boot (see "Divergences").
- `pluginBootCard.ts` — formats the `[plugins] N loaded · M pending · K suspended` boot line with severity routing.

### Bundled plugin (`plugins/aiden-plugin-cdp-browser/`)
- `plugin.json` — declares `browser`, `subprocess`, `network` permissions.
- `index.js` — registers `browser_real_click`, `browser_real_extract`, `browser_real_eval`. Activates Chrome-debug attach via `onActivate`.
- `lib/chromeLauncher.js` — `/json/version` probe, dedicated `<aiden-home>/chrome-debug` profile, detached-subprocess spawn. Direct port of Hermes `hermes_cli/browser_connect.py`.
- `lib/cdpClient.js` — thin wrapper over `chrome-remote-interface` (^0.34.0).

### Slash command (`cli/v4/commands/plugins.ts`)
- `/plugins list | info <name> | install <local-path> | grant <name> | remove <name> | reload`.
- Install: local paths only (URLs rejected with v4.1 deferral message). Permission summary → `[y/N]` confirm → `.granted-permissions.json` written → reload.
- Grant: re-prints summary, flags `NEW permissions requested:` for upgrades, persists full declared set, reloads.
- Remove: blocked for `kind: bundled` plugins; user plugins teardown + delete dir.
- Reload: `.granted-permissions.json` lives inside plugin dir, untouched by reload.

### Boot wiring (`cli/v4/aidenCLI.ts`)
PluginLoader constructed in `buildAgentRuntime` after the moat layers, before tool-executor build. Boot card rendered next to `[skills]`. `pluginLoader.teardown()` called on shutdown.

## Permissions trust model

Advisory only — Pro-tier UX, not a security boundary. Three load-time states from `evaluatePermissionState`:

| State | Loader behavior | Tool behavior | Boot card severity |
|---|---|---|---|
| `granted` | `register()` runs; tools registered normally | Execute as written | green |
| `pending-grant` | `register()` runs; PluginContext wraps tools | Execute returns honest refusal: `permissions not granted for X. Run: /plugins grant X` | yellow |
| `suspended` | `register()` NOT called; `missingPermissions` populated | Tools never registered | red |

The `suspended` state is the load-bearing piece: when a plugin updates and asks for new permissions, it suspends instead of silently gaining access. User must re-grant via `/plugins grant`. Hermes has no equivalent (audit doc records the divergence).

## Test count

**62 tests**, all green. **+25 minimum** in spec exceeded by 37.

| Group | Count |
|---|---|
| Manifest validation | 8 |
| Loader discovery + register | 8 |
| Plugin context | 4 |
| Registry | 3 |
| CDP client + plugin tools | 9 |
| /plugins commands | 12 |
| Permission state eval + /plugins grant | 8 |
| Bundled restore + boot card | 9 |
| Phase 17 architectural smoke | 1 |

**Cost: $0.** Every test mocks `chrome-remote-interface`, the LLM adapter, file system as needed, and the confirm prompt. No live API calls anywhere in Phase 17.

## Divergences from spec / Hermes

1. **Bundled plugins discovered in-place** at `<package>/plugins/`, not copied to `paths.pluginsDir`. The Phase 17 spec's "first-run copy" intent breaks down for plugins with npm dependencies — `chrome-remote-interface` only resolves from the package install root. `restoreBundledPluginsIfNeeded` is kept as a helper (and tested) for future dep-free plugins, but boot uses `bundledDir` discovery directly. User-installed plugins still live at `paths.pluginsDir`.
2. **Project-local plugins (`./.aiden/plugins/`) deferred** to v4.1. Hermes supports them gated by an env var; for v4.0 the injection vector outweighs the value.
3. **npm entry-point plugin discovery deferred** to v4.1. Adding it requires a registry/signing strategy outside Phase 17 scope.
4. **OS-level sandboxing deferred** to v4.1. v4.0 ships advisory-only permission grants per audit + user clarification.
5. **Manifest re-grant on upgrade** is net-new for Aiden (Hermes has no equivalent) — see permissions table above.

## Manual smoke (user pass)

Real-LLM + real-Chrome verification of the full "play song" loop is the manual gate. Steps:

1. Run `aiden` (boot card should show `[plugins] 0 loaded · 1 pending grant · 0 suspended` with the `/plugins grant aiden-plugin-cdp-browser …` hint).
2. `/plugins grant aiden-plugin-cdp-browser` → confirm. Boot card flips to `[plugins] 1 loaded`.
3. Prompt: `play me a popular song`. Expect: `media-search` skill → `web_search` → `open_url(youtube.com)` → CDP attaches → `browser_real_click` on the first `/watch?v=` result → playback starts.

## Deferred / known gaps

- The bundled plugin's `onActivate` will throw on machines without a Chrome-family binary. Currently surfaced via the loader's `[plugins] hook onActivate threw` warn line. v4.1 should turn this into a `pending-grant`-style boot card with the manual-launch command.
- `/plugins install` only accepts local paths. URL/git install lands in v4.1.
- The `confirm` hook used by `/plugins install` and `/plugins grant` is wired through `ChatPromptApi.readLine`. Tests inject mock confirmers; the chat REPL goes through the real readline. TUI mode hasn't been verified yet — likely needs a TUI-specific confirm.

## Next phase

Phase 18 — Windows native build + OAuth providers as bundled plugins (Claude Pro / ChatGPT Plus subscription auth, deferred from 16f Audit). Plugin architecture is now in place; OAuth providers slot in as `kind: bundled` plugins that contribute provider configs.
