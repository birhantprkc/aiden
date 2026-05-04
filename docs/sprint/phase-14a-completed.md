# Phase 14a — Visual foundation + diagnostics

Status: complete (2026-05-04). 14b (slash registry, model picker, callbacks) and 14c (REPL, aidenCLI, sessions/skills handlers) follow. Scope: `cli/v4/` Display+SkinEngine, Doctor, SetupWizard. Out: slash registry, model picker, callbacks, REPL, aidenCLI.

## Task 1 inventory

| Source | Relevant nodes |
|---|---|
| Hermes doctor | `hermes_cli/doctor.py::run_doctor` — checks return `{name,status,message,suggestion}`. |
| Hermes setup | `hermes_cli/setup.py::run_setup_wizard`, `select_provider_and_model`, `prompt_choice`. |
| Hermes skin/banner | `hermes_cli/skin_engine.py::get_active_skin`, `banner.py::build_welcome_banner`. |
| v3 | `core/doctor.ts::runDoctor`, `core/setupWizard.ts::runSetupWizard`+`isSetupComplete`. No prod banner module on v3. |

## Task 2 library decisions

| Library | Status | Reason |
|---|---|---|
| `chalk@^5`, `ora@^9` | installed but **not used** | ESM-only; project is CJS. |
| `kleur` | newly installed | CJS color; Display uses a custom 24-bit ANSI helper since kleur has no `.rgb()`. |
| `marked` + `marked-terminal` | newly installed | CJS; powers `Display.markdown()`. |
| `@inquirer/prompts` | newly installed | CJS-compatible modular inquirer. |
| `commander`, `enquirer` | deferred | not needed in 14a. |

## Task 3 subsystem APIs

```ts
class SkinEngine {
  constructor(opts?: { skinsDir?: string; onError?: (m: string) => void; forceMono?: boolean });
  getActive(): SkinDefinition;
  loadSkin(name: string): Promise<SkinDefinition>;
  setActive(name: string): SkinDefinition;
  applyColors(text: string, kind: ColorKind): string;
  listSkins(): string[];
}
class Display {
  constructor(opts?: { skin?: SkinEngine; stdout?: WriteStream; stderr?: WriteStream });
  banner(version?: string): string; printBanner(version?: string): void;
  startSpinner(text: string): SpinnerHandle;
  toolPreview(name: string, args: unknown): string; markdown(text: string): string;
  userTurn(text: string): string; agentTurn(text: string, opts?: AgentTurnOptions): string;
  error(message: string, suggestion?: string): string;
}
function runDoctor(opts?: DoctorOptions): Promise<DoctorReport>;
function runDoctorCli(opts?: DoctorOptions): Promise<DoctorReport>;
// + 10 individual check fns (config/providerAuth/ollama/python/docker/npx/skills/manifest/paths/logs)
const PROVIDERS: ProviderOption[]; // 19 entries
function isFreshInstall(paths: AidenPaths): Promise<boolean>;
function runSetupWizard(opts?: SetupOptions): Promise<SetupResult>;
```

## Task 7 smoke gate (real PowerShell)

| Command | Exit | Wall | Notes |
|---|---|---|---|
| `runDoctorCli()` via tsx | 1 | 2.9s | 10 checks, 4 fail; aggregate 174 ms; no hangs |
| `display.banner()` via tsx | 0 | 3.6s | full ANSI brand-orange banner |
| `setupWizard` import via tsx | 0 | 3.9s | `runSetupWizard` resolved; `PROVIDERS.length === 19` |

tsx wraps CJS exports in `m.default`; normal TS imports work in callers.

## Test counts

| | Phase 13 | 14a | Δ |
|---|---:|---:|---:|
| v4 unit (excl integration) | 652 | **702** | +50 |
| 14a-specific (display 18, doctor 19, wizard 13) | — | 50 | +50 |
| Live-LLM integration flakes | 8 | 12 (all 429 rate-limit) | quota |
| Full `npm test` | 2078 | 2122 | +44 |

`tsc --noEmit` → 0 errors; `vitest run tests/v4/cli/` → 50/50. Native-modules and `scripts/test-suite/regression` file-level failures verified pre-existing on stashed-scaffold baseline.

## Commits + backup push

| SHA | Message | Pushed |
|---|---|---|
| `2e7225c` | feat(v4): CLI display + skin engine | yes |
| `6211d34` | feat(v4): aiden doctor diagnostic command | yes |
| `0821bf8` | feat(v4): setup wizard with provider picker | yes |
| (this commit) | docs(v4): phase 14a summary | pending |

## What 14b imports from 14a

```ts
import { Display, getDisplay } from './display';
import { SkinEngine, getSkinEngine } from './skinEngine';
import { PROVIDERS, type ProviderOption, isFreshInstall } from './setupWizard';
// 14c additionally imports `runDoctorCli` for the `aiden doctor` subcommand.
```

## Deferred

- Spinner: custom Unicode-frame impl (not `ora`, which is ESM-only).
- Pro options [1]/[2] short-circuit with the v4.1 OAuth-wizard stub.
- Terminal-backend picker recorded as `'auto'`; full picker → 14b.
- Skin YAML loader wired but no example skins shipped yet.
