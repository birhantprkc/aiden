# Hermes audit — web-search backend (Phase 16f)

**Question:** Bundle a `web_search` skill so we don't have to launch a browser
for "search latest AI news"-style queries. What backend does Hermes use?

## Sources
- `tools/web_tools.py:1074-1170` — `web_search_tool(query, limit=5)`.
  Generic interface dispatching to one of:
  - **Parallel** (`_parallel_search`)
  - **Exa** (`_exa_search`)
  - **Tavily** (`_tavily_request("search", …)`)
  - **Firecrawl** (mentioned in module docstring)
  Backend selected by config / env.
- Return shape: `{"success": bool, "data": {"web": [{title, url, description, position}]}}`.
- All four backends are **paid APIs**. No DuckDuckGo HTML scrape, no
  Google scrape.

## Findings
1. **Hermes ships paid-only.** No free fallback for `web_search`. Users
   either wire Tavily/Exa/Parallel/Firecrawl or `web_search` errors out.
2. **Pluggable backend** — same return shape across all four; backend
   selected via `tools.web_search.backend` config + per-backend API key.
3. **Result shape is OpenAPI-shaped** — `{title, url, description,
   position}` per result. Easy to surface as chat output without further
   formatting.
4. **No browser needed** — pure HTTPS calls to the search API. Avoids
   CAPTCHA / Playwright detection / browser lifecycle entirely.

## Decision: **defer** (skip bundled skill; document Tavily/Exa wiring in v4.1)

Three options:

(a) **Bundle DuckDuckGo HTML scrape** as a no-API-key fallback. Brittle
    (DDG changes selectors), often rate-limited, and produces low-quality
    snippets. **Reject** — flaky baselines erode trust.

(b) **Bundle Tavily** with a free-tier baseline ($1k req/mo free). Adds
    one more provider key to manage; ships a real-quality backend. But
    requires user signup. **Reject for v4.0** — adds setup friction.

(c) **Defer entirely** to v4.1 plugin system. For Phase 16f, "search
    the web for X" requests use `open_url` (Audit B) — launches the
    user's actual browser at `https://www.google.com/search?q=X`. User
    sees results in their normal browser, no Aiden-side parsing needed.
    Gracefully degrades the use case to "browser-mediated search" with
    no detection issues. **Adopt.**

The shell-launch pattern from Audit B subsumes this use case for v4.0.
A real `web_search` API-backed tool ships when v4.1 plugin architecture
lands and we can include Tavily/Exa as opt-in installs.

## What we're NOT copying
- The full backend dispatcher — wait until plugin architecture is real.
- The `{success, data: {web: [...]}}` return shape — we'll mirror it
  when we do bundle a backend in v4.1, but no point shipping the
  return type without a producer.
