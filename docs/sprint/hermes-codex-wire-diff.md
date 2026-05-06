# Hermes vs Aiden — Codex wire-level diff (Phase 21 #6 reopen)

**Method:** graphify on `references/hermes-agent` for `codex chatgpt request body headers`; targeted reads on `agent/transports/codex.py`, `agent/codex_responses_adapter.py`, `agent/auxiliary_client.py:_codex_cloudflare_headers`. Aiden side: `providers/v4/codexResponsesAdapter.ts` + `providers/v4/runtimeResolver.ts`.

## TL;DR — Cloudflare blocks Aiden's requests; Hermes spoofs codex_cli_rs

Aiden's `CodexResponsesAdapter` already speaks the OpenAI Responses API at the right endpoint (`/responses`) with the right body shape (`{model, instructions, input, tools, parallel_tool_calls, store: false}`). What's missing: the **Cloudflare-bypass headers** that the `chatgpt.com/backend-api/codex` Cloudflare layer requires. Without them, requests fail at the edge regardless of auth correctness — manifesting as the user-reported HTTP 400 *"model is not supported when using Codex with a ChatGPT account."*

## Hermes Codex headers (verbatim, `agent/auxiliary_client.py:360-396`)

```python
def _codex_cloudflare_headers(access_token: str) -> Dict[str, str]:
    headers = {
        "User-Agent": "codex_cli_rs/0.0.0 (Hermes Agent)",
        "originator": "codex_cli_rs",
    }
    # Extract ChatGPT-Account-ID from JWT claim
    parts = access_token.split(".")
    payload_b64 = parts[1] + "=" * (-len(parts[1]) % 4)
    claims = json.loads(base64.urlsafe_b64decode(payload_b64))
    acct_id = claims.get("https://api.openai.com/auth", {}).get("chatgpt_account_id")
    if isinstance(acct_id, str) and acct_id:
        headers["ChatGPT-Account-ID"] = acct_id
    return headers
```

Three required headers:

| Header | Value | Why |
|---|---|---|
| `User-Agent` | `codex_cli_rs/0.0.0 (<app> Agent)` | Cloudflare's whitelist allows codex_cli_rs UAs; the OpenAI SDK's default UA is rejected |
| `originator` | `codex_cli_rs` | Cloudflare allowlist sentinel — pinned to match upstream codex-rs CLI |
| `ChatGPT-Account-ID` | `<chatgpt_account_id from JWT>` | Canonical casing per codex-rs `auth.rs`; binds the request to the user's ChatGPT account |

The `chatgpt_account_id` is extracted from the OAuth JWT's `https://api.openai.com/auth` claim. Malformed tokens drop the header (don't raise) so a bad token surfaces as 401 rather than a crash at construction.

## Body-shape diff

| Field | Hermes | Aiden | Status |
|---|---|---|---|
| URL | `/responses` | `/responses` | ✓ |
| `model` | string | string | ✓ |
| `instructions` | system prompt | system prompt | ✓ |
| `input` | converted Responses items | converted | ✓ |
| `tools` | function defs | function defs | ✓ |
| `tool_choice` | `'auto'` | `'auto'` | ✓ |
| `parallel_tool_calls` | `true` | `true` | ✓ |
| `store` | `false` | `false` | ✓ |
| `max_output_tokens` | **OMITTED on Codex backend** (transports/codex.py:142-143) | always sent | ❌ Codex 400s |
| `reasoning` | `{effort: 'medium', summary: 'auto'}` | not set | ⚠ functional but degraded |
| `include` | `['reasoning.encrypted_content']` | not set | ⚠ same |
| `prompt_cache_key` | session_id | not set | ⚠ no cross-turn cache |
| `session_id` (header) | from prompt_cache_key | not set | ⚠ |
| `x-client-request-id` (header) | same | not set | ⚠ |

## Aiden gap

`providers/v4/codexResponsesAdapter.ts:170-178` builds headers as just:

```ts
const headers = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${this.apiKey}`,
  ...this.extraHeaders,
};
```

No `User-Agent` override, no `originator`, no `ChatGPT-Account-ID`. The OpenAI SDK's default UA leaks through (or worse, the platform's Node UA on a manual fetch). Cloudflare's edge layer matches against `originator: codex_cli_rs` and the codex-rs UA fingerprint; without them, ChatGPT-account-bearing tokens get the user-reported "model not supported" rejection.

Plus `buildRequestBody` line 272 unconditionally sends `max_output_tokens` when set — Codex backend rejects it.

## Decision

Detect Codex backend (`baseUrl` contains `chatgpt.com/backend-api/codex`) inside `CodexResponsesAdapter`. When detected:
1. Override `User-Agent` to `codex_cli_rs/0.0.0 (Aiden Agent)`.
2. Add `originator: codex_cli_rs`.
3. Decode JWT, extract `chatgpt_account_id`, send as `ChatGPT-Account-ID` (canonical casing). Tolerate malformed tokens.
4. Omit `max_output_tokens` from the body.

Phase 21 ships steps 1–4 (the user-blocking fix). Reasoning config + session-id + prompt_cache_key are quality-of-life additions; ship as follow-on. The fix is internal to the adapter — no registry/catalog churn, no caller changes.
