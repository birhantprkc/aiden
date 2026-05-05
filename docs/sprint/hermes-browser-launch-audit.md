# Hermes audit — browser launch strategy (Phase 16f)

**Question:** Aiden v3 used `start chrome <url>` (terminal-based, real user
profile, no CAPTCHA). Aiden v4 routes everything through Playwright,
which gets detected and CAPTCHA-walled. What does Hermes do?

## Sources
- `tools/browser_tool.py:215-356` — Hermes drives Chrome via **CDP**
  (Chrome DevTools Protocol). The user runs Chrome themselves with
  `--remote-debugging-port=9222`; Hermes connects via CDP URL. Real
  user profile, real cookies, real login state.
- `tools/browser_tool.py:264-287` — `_get_cdp_override()` resolves the
  CDP URL from (1) `BROWSER_CDP_URL` env var or (2) `browser.cdp_url`
  in config.yaml.
- `tools/browser_cdp_tool.py` — separate tool for managing the CDP
  supervisor connection.

## Findings
1. **Hermes does NOT spawn Chrome itself.** It expects an already-running
   Chrome instance with CDP enabled. The user starts it with
   `chrome --remote-debugging-port=9222 --user-data-dir=<their profile>`.
2. **Real-profile = no CAPTCHA.** Because the Chrome instance is the
   user's daily-driver Chrome with their cookies/login state, sites
   don't see "headless Chrome / Playwright" fingerprints.
3. **No `start chrome <url>` shell-launch path.** Hermes assumes power
   users who'll set up CDP. Less power-user-friendly than v3's pattern.
4. **Browserbase / cloud-browser fallback** for ephemeral / non-local use
   (gateway batched runs).

## Decision: **diverge** (shell-launch path for v4.0; CDP for power users in v4.1)

Aiden v4 is a single-user CLI; users won't set up `--remote-debugging-port`.
The v3 pattern (`start chrome <url>` on Windows, `open <url>` on macOS,
`xdg-open <url>` on Linux) gives the same anti-detection win without
any setup — uses the user's default-browser default-profile.

For programmatic interactions (click/type/extract) we keep the existing
Playwright path under `browser_navigate / browser_click / browser_type`
(detected, CAPTCHA-prone, but that's the price for automation).

**Plan:**
1. **New tool: `open_url(url)`** — platform-aware shell launch:
   - Windows: `cmd.exe /c start "" <url>`
   - macOS: `open <url>`
   - Linux: `xdg-open <url>`
   Uses the user's default browser, not Playwright. No CAPTCHA. No
   "browser instance" lifecycle.
2. **System prompt nudge** — when the user says "open X in chrome / browser",
   prefer `open_url` over `browser_navigate`. `browser_navigate` reserved
   for "I need to read / interact with this page programmatically."
3. **Domain allowlist** integrates with Audit A — `open_url` to allowlisted
   domains is auto-approved; non-allowlisted prompts.
4. **CDP path deferred to v4.1** as an opt-in for power users.

## What we're NOT copying
- CDP supervisor lifecycle — too much setup for v4.0 single-user UX.
- Browserbase cloud-browser plumbing — v4.1 plugin territory.
