# Hermes audit — tool success semantics + honesty (Phase 16f)

**Question:** Aiden navigated to a CAPTCHA page and reported "search
completed." This breaks the entire pitch. How does Hermes prevent the
model from claiming success on tools that actually failed?

## Sources
- `tools/browser_tool.py:1397-1594` — every browser failure path returns
  `{"success": False, "error": "..."}`:
  - `1397`: `{"success": False, "error": str(e)}` (bare exception)
  - `1414-1424`: `{"success": False, "error": "Interrupted"}` /
    `"Failed to create browser session: ..."`
  - `1514`: `{"success": False, "error": f"Command timed out after {timeout}s"}`
  - `1541`: `{"success": False, "error": f"Browser command '{command}' returned no output"}`
  - `1580-1588`: `{"success": False, "error": error_msg}` for inner failures
- Pattern: every tool wrapper returns `{success: bool, error?: str}` —
  the model sees this in the tool result message and is expected to
  surface it accurately.

## Findings
1. **Strict result shape across all tool wrappers.** Hermes never returns
   ambiguous "ok" without an explicit `success: true`.
2. **No silent failure.** If anything goes wrong, `success: False` with
   a human-readable `error`. No try/except that swallows errors.
3. **CAPTCHA handling**: not a special case in Hermes browser_tool,
   because Hermes uses real-profile-via-CDP (Audit B) and rarely hits
   CAPTCHAs. When it does (rare), the page extraction returns weird
   content but `success: true` because the navigate technically worked.
   The model is trusted to detect "this page looks like a CAPTCHA" from
   the content.
4. **HonestyEnforcement-equivalent:** Hermes doesn't have an explicit
   post-loop honesty layer. They rely on (a) accurate tool result shape
   and (b) the model's natural reading comprehension of tool results.
   Aiden has Phase 12 HonestyEnforcement which can catch more cases.

## Decision: **copy + extend** (strict result shape + extend HonestyEnforcement to detect content-blocked pages)

Aiden mostly already does (1) via `Phase 9 tool wrappers surface verified flag`.
The CAPTCHA-claimed-success bug came from `browser_navigate` returning
`{success: true}` even when the resulting page was a CAPTCHA wall —
the tool considered "navigation completed" success, ignoring page
content.

**Plan:**
1. **Tool wrapper invariant** (already mostly there): every tool returns
   `{success: bool, error?: string, ...}`. Lock with unit tests.
2. **`browser_navigate` extends success check**: after navigation, peek
   at page title / first H1 / common CAPTCHA markers. If detected,
   return `{success: false, error: "Page appears to be a CAPTCHA / bot
   challenge. Try open_url instead (uses your real browser)."}`. The
   error message tells the model the right next step.
3. **HonestyEnforcement extension** (Phase 16e moat shipped): when a
   tool returns `success: false` and the agent's response uses
   completion language ("I searched", "found", "navigated"), rewrite
   to surface the failure. Phase 12 HonestyEnforcement already handles
   the memory_add case; extend to all tools.
4. **CAPTCHA detection heuristic** — simple text match on common
   strings: "Please verify you are human", "I'm not a robot",
   "Cloudflare", "Access denied", "captcha". Conservative; misses are
   acceptable (model still reads the content).

## What we're NOT copying
- Hermes's "trust the model to read tool results" stance — we have
  HonestyEnforcement as a stronger guarantee. Use it.
- Per-backend custom error categories — `success: false + error: str`
  is enough surface for v4.0.
