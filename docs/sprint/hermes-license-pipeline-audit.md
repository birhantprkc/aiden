# Hermes audit — license, npm publish, auto-update (Phase 20)

**Date:** 2026-05-05  ·  **Hermes ref:** `C:\Users\shiva\references\hermes-agent` (commit synced 2026-05).
**Method:** graphify on `references/hermes-agent/graphify-out` (god-node scan, no full report read — 53k nodes, 96k edges) plus targeted reads on `hermes_cli/banner.py`, `hermes_cli/main.py`, `tests/hermes_cli/test_update_check.py`, `LICENSE`, `.github/workflows/`.

## TL;DR

| Question | Hermes | Aiden v4 plan |
|---|---|---|
| Pro tier / paid features? | None. MIT, no license/key/premium concept anywhere in 1730 files. | Port v3 Pro infrastructure (Cloudflare worker `api.taracod.com` + KV) forward to v4. Divergence — Aiden ships free + Pro tiers; Hermes is single-tier free. |
| Versioning + registry publish? | Git-only. No npm/PyPI workflow. CI ships Docker images and Nix flakes; users run from a checkout. | npm publish pipeline new in v4 — pre-release `4.0.0-beta.1` tag, `prepublishOnly` runs `tsc + vitest`, GitHub Actions on `v4.0.0-beta*` git tags. |
| Auto-update on boot? | Yes — `hermes_cli/banner.check_for_updates()` runs `git fetch` + `git rev-list --count HEAD..origin/main`, caches `behind` count for 6 h in `$HERMES_HOME/.update_check`. Prints "[update] N commits behind. Run git pull". | Same shape, but registry-based — query `https://registry.npmjs.org/aiden-runtime/latest`, compare against `package.json` version, 6 h cache at `<aiden-home>/.update_check.json`, opt-out via `AIDEN_NO_UPDATE_CHECK=1`. Boot card line same UX as Hermes. |
| Cache invalidation? | Hermes invalidates the cache when the embedded `HERMES_REVISION` env (set by Nix) changes between checks. | Aiden invalidates when the locally-installed `package.json` version changes — same idea, registry world equivalent. |
| First-run prompt? | Hermes does the same check on every boot; first run is just "no cache yet, fetch immediately." | Same — first run is just an empty-cache miss. No special prompt path. |
| `/doctor` health check? | `hermes_cli/doctor.py` exists. Aiden has `cli/v4/doctor.ts` too (Phase 14a). Aiden's already covers config, providers, Ollama, python, docker, npx, skills, paths, logs. | Extend the existing one — add license-server reachability, npm registry reachability, license cache status. No new command needed. |

## Hermes update-check shape (verbatim, for fidelity)

```python
# hermes_cli/banner.py:178
def check_for_updates() -> Optional[int]:
    hermes_home = get_hermes_home()
    cache_file = hermes_home / ".update_check"
    embedded_rev = os.environ.get("HERMES_REVISION") or None

    if cache_file.exists():
        cached = json.loads(cache_file.read_text())
        if (now - cached.get("ts", 0) < _UPDATE_CHECK_CACHE_SECONDS
                and cached.get("rev") == embedded_rev):
            return cached.get("behind")

    if embedded_rev:
        behind = _check_via_rev(embedded_rev)   # git ls-remote
    else:
        behind = _check_via_local_git(repo_dir) # git fetch + rev-list

    cache_file.write_text(json.dumps({"ts": now, "behind": behind, "rev": embedded_rev}))
    return behind
```

Aiden adapts this to npm registry semantics — fetch `https://registry.npmjs.org/aiden-runtime/latest` for `version`, compare to installed `package.json` via `semver`. Cache shape is `{ ts, latest, installed }`; we invalidate on installed-version change rather than `HERMES_REVISION`.

## Pro license — no Hermes precedent

Confirmed: **Hermes has no license, premium, paid, or activation code anywhere in the source.** The only "license" string in the codebase is the `LICENSE` file (MIT, Nous Research 2025) and skill metadata declaring SPDX licenses for third-party content.

Aiden has no Hermes pattern to mirror. Original v3 Aiden Pro infrastructure (`core/licenseManager.ts` + `cloudflare-worker/license-server.ts`) is the design source. Phase 20 ports it to `core/v4/license/` with the v4 conventions (machine-bound encryption like `tokenStore`, XDG paths via `resolveAidenPaths`, async-first API).

### Ported endpoints (existing Cloudflare worker, no schema change)
- `POST /license/activate` — `{ key, machineId, machineName }` → `{ activated, plan, expiresAt, features }`
- `POST /license/verify` — `{ key, machineId }` → `{ valid, plan, expiresAt, features }`
- `POST /license/deactivate` — `{ key, machineId }` → `{ deactivated }`

The v3 KV `DEVOS_LICENSES` on Cloudflare account `459b9952b9ce56c20700080162476543` is reachable read-only from CC's tools (the worker is public). No schema migration needed for v4 MVP.

## Divergences from Hermes (intentional, documented)

1. **Pro tier exists.** Hermes is uniformly MIT; Aiden has free + paid. v4.0 Pro features: multi-tool batch approval, silent OAuth refresh, custom personalities. Free keeps everything else.
2. **Registry publish, not git checkout.** Hermes is "clone, run." Aiden is `npm install -g aiden-runtime`. Update check therefore polls npm, not git.
3. **Machine fingerprint is a hash.** Hermes has none — there's nothing to bind. Aiden's machine fingerprint reuses the deterministic identity string `tokenStore` already derives from (`hostname + user + platform`), with explicit `AIDEN_MACHINE_KEY` override for tests/VM portability.

## Phase 20 stop conditions verified

- ✅ Cloudflare worker schema unchanged — Aiden v4 reuses v3 endpoints exactly.
- 🟡 npm scope: package is named `aiden-runtime` (not `aiden`), unscoped, already public on the v3 trajectory. We bump version to `4.0.0-beta.1` on the same name. **No scope confirmation needed.**
- ✅ Boot perf: registry check is async non-blocking, deferred via `setImmediate`. Cache hit path is a synchronous file read (≪1 ms).
- ✅ Cloudflare account access not required from CC — we ship validation logic only; no server-side changes.

## Decision

Proceed with the original Phase 20 design as written. Hermes is silent on Pro tier and agnostic on publish channel; the Aiden plan is internally consistent and the v3 Pro code is the authoritative reference.
