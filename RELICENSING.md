# Relicensing policy

Aiden is licensed under **AGPL-3.0** (see [LICENSE](LICENSE)). Taracod Labs /
Shiva Deore retains the option to offer Aiden under additional licenses,
including proprietary or commercial terms, as permitted by the Contributor
License Agreement ([.github/CLA.md](.github/CLA.md)).

This document records the scope of any such relicensed or commercially-licensed
distribution.

## Scope of a relicensed distribution

Any relicensed or commercially-licensed distribution of Aiden **excludes the
legacy v3 stack**. The v3 code is dead — it is not shipped by, imported by, or
required for the v4 CLI (`dist/cli/v4/aidenCLI.js`, the package `bin` / `main`).
The excluded v3 files and areas are:

- `providers/*` (repository root — the v3 provider stack)
- `core/agentLoop.ts`
- `core/reactLoop.ts`
- `core/modelRouter.ts`
- `api/server.ts`
- `cli/aiden.ts`
- the remaining legacy `core/*` cluster (the v3 engine — files under `core/`
  that are **not** under `core/v4/`)

## Rationale

The only substantive third-party contribution to this repository — the Mistral
provider (PR #69, originally PR #31, co-authored by Genmin) — lives **entirely
in the v3 stack** (`providers/mistral.ts`, plus edits to `api/server.ts` and
`core/agentLoop.ts`). Excluding the v3 stack from any relicensed distribution
means **no third-party copyright encumbers that distribution**.

## Contributor notes

- **v4 code is solely authored by Shiva Deore.** All of `core/v4/**`,
  `cli/v4/**`, `providers/v4/**`, `tools/v4/**`, and `moat/**` is the original
  work of Shiva Deore (Taracod), who holds full rights to relicense it.
- **Ayush9924** — the only other non-Shiva author — contributed a single
  one-line change (PR #68, `cli/aiden.ts`). It is DCO sign-off signed and de
  minimis (not copyrightable-significant).

## Note on history

This policy is forward-looking and documentary. Git history is not rewritten.
