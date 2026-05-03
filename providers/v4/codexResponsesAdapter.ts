/**
 * providers/v4/codexResponsesAdapter.ts — Aiden v4.0.0
 *
 * Adapter for OpenAI's /v1/responses (Codex) wire format.
 *
 * Status: PHASE 4 — minimum-viable API-key path. Sufficient to validate the
 *   wire-format mapping (request shape, response.output[] item parsing,
 *   finish-reason semantics). Full feature set lands Phase 13:
 *     - ChatGPT subscription OAuth flow
 *     - Reasoning-item replay (encrypted_content round-trip)
 *     - Streaming
 *     - prompt_cache_key + Codex-backend session_id headers
 *     - xAI / GitHub Models / chatgpt.com backend variants
 *     - _preflight_codex_api_kwargs sanitization
 *
 * No real-network integration test in Phase 4 — gated on Phase 13 OAuth wiring
 * and an OpenAI Responses-API key (gpt-5-codex is gated). Unit tests with
 * mocked fetch carry the load until then.
 *
 * Hermes reference: agent/transports/codex.py + agent/codex_responses_adapter.py
 *
 * Wire-format quirks handled here:
 *   1. Endpoint: /v1/responses (NOT /v1/chat/completions).
 *   2. Top-level `instructions` field carries the system prompt; messages array
 *      becomes `input` items.
 *   3. Tool schema is FLAT: {type:'function', name, description, strict, parameters}
 *      (no nested function: {...}).
 *   4. Response.output[] is a list of items: message / reasoning / function_call.
 *   5. response.status ∈ {completed, incomplete, failed, cancelled}; mapped to
 *      v4's {stop, tool_use, length}.
 *   6. Empty output[] with output_text backfill is legal (rare stream-recovery case).
 *   7. Usage at response.usage.{input_tokens, output_tokens, cached_tokens}.
 *   8. store=false default — we do not persist threads server-side.
 */

import {
  ApiMode,
  Message,
  ProviderAdapter,
  ProviderCallInput,
  ProviderCallOutput,
  ToolCallRequest,
  ToolSchema,
} from './types';
import {
  ProviderError,
  ProviderRateLimitError,
  ProviderTimeoutError,
} from './errors';

export interface CodexResponsesAdapterOptions {
  /** Default 'https://api.openai.com/v1'. No trailing slash. */
  baseUrl?: string;
  /** Bearer token. */
  apiKey: string;
  /** e.g. 'gpt-5-codex', 'gpt-4.1-mini'. */
  model: string;
  /** For error messages and logging. */
  providerName: string;
  /** Per-request timeout. Default 120_000. */
  timeoutMs?: number;
  /** Retries on 429 / 5xx / network. Default 2 (3 attempts total). */
  maxRetries?: number;
  /** Extra headers (escape hatch). */
  extraHeaders?: Record<string, string>;
}

interface ResponsesTool {
  type: 'function';
  name: string;
  description: string;
  strict: boolean;
  parameters: ToolSchema['inputSchema'];
}

interface ResponsesInputContentPart {
  type: 'input_text' | 'output_text';
  text: string;
}

interface ResponsesMessageItem {
  type: 'message';
  role: 'user' | 'assistant';
  content: ResponsesInputContentPart[];
}

interface ResponsesFunctionCallItem {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
}

interface ResponsesFunctionCallOutputItem {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

type ResponsesInputItem =
  | ResponsesMessageItem
  | ResponsesFunctionCallItem
  | ResponsesFunctionCallOutputItem;

interface ResponsesOutputMessage {
  type: 'message';
  role?: string;
  content?: Array<{ type: string; text?: string }>;
  status?: string;
}

interface ResponsesOutputFunctionCall {
  type: 'function_call';
  id?: string;
  call_id?: string;
  name: string;
  arguments: string | Record<string, unknown>;
  status?: string;
}

interface ResponsesOutputReasoning {
  type: 'reasoning';
  encrypted_content?: string;
  summary?: Array<{ type: string; text?: string }>;
}

type ResponsesOutputItem =
  | ResponsesOutputMessage
  | ResponsesOutputFunctionCall
  | ResponsesOutputReasoning
  | { type: string; [k: string]: unknown };

interface ResponsesAPIResponse {
  output?: ResponsesOutputItem[];
  output_text?: string;
  status?: string;
  incomplete_details?: { reason?: string };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cached_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
  };
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RETRIES = 2;

export class CodexResponsesAdapter implements ProviderAdapter {
  apiMode: ApiMode = 'codex_responses';
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly providerName: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly extraHeaders: Record<string, string>;

  constructor(options: CodexResponsesAdapterOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.providerName = options.providerName;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.extraHeaders = options.extraHeaders ?? {};
  }

  async call(input: ProviderCallInput): Promise<ProviderCallOutput> {
    const body = this.buildRequestBody(input);
    const url = `${this.baseUrl}/responses`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
      ...this.extraHeaders,
    };

    const totalAttempts = this.maxRetries + 1;
    let lastTransientError: ProviderError | null = null;

    for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
      try {
        const response = await this.fetchWithTimeout(url, headers, body);

        if (response.ok) {
          const json = (await response.json()) as ResponsesAPIResponse;
          return this.parseResponse(json);
        }

        const status = response.status;
        const rawText = await this.safeReadText(response);

        if (status >= 400 && status < 500 && status !== 429) {
          throw new ProviderError(
            `Provider ${this.providerName} returned ${status}: ${rawText.slice(0, 500)}`,
            this.providerName,
            status,
            rawText,
            false,
          );
        }

        lastTransientError = status === 429
          ? new ProviderRateLimitError(this.providerName, rawText)
          : new ProviderError(
              `Provider ${this.providerName} returned ${status}: ${rawText.slice(0, 500)}`,
              this.providerName,
              status,
              rawText,
              true,
            );

        if (attempt < totalAttempts) {
          await this.sleep(this.backoffMs(attempt));
          continue;
        }
        throw lastTransientError;
      } catch (err) {
        if (err instanceof ProviderError && !err.retryable) throw err;
        if (err instanceof ProviderTimeoutError) {
          lastTransientError = err;
          if (attempt < totalAttempts) {
            await this.sleep(this.backoffMs(attempt));
            continue;
          }
          throw err;
        }
        if (err instanceof ProviderError) {
          lastTransientError = err;
          if (attempt < totalAttempts) {
            await this.sleep(this.backoffMs(attempt));
            continue;
          }
          throw err;
        }
        const wrapped = new ProviderError(
          `Provider ${this.providerName} request failed: ${err instanceof Error ? err.message : String(err)}`,
          this.providerName,
          undefined,
          err,
          true,
        );
        lastTransientError = wrapped;
        if (attempt < totalAttempts) {
          await this.sleep(this.backoffMs(attempt));
          continue;
        }
        throw wrapped;
      }
    }

    throw lastTransientError ?? new ProviderError(
      `Provider ${this.providerName} exhausted retries`,
      this.providerName,
    );
  }

  private buildRequestBody(input: ProviderCallInput): Record<string, unknown> {
    const { instructions, items } = this.translateMessages(input.messages);
    const body: Record<string, unknown> = {
      model: this.model,
      input: items,
      tool_choice: 'auto',
      parallel_tool_calls: true,
      store: false,
    };
    if (instructions) body.instructions = instructions;
    if (input.tools.length > 0) {
      body.tools = this.translateTools(input.tools);
    }
    if (input.maxTokens != null) body.max_output_tokens = input.maxTokens;
    if (input.temperature != null) body.temperature = input.temperature;
    if (input.extraBody) Object.assign(body, input.extraBody);
    return body;
  }

  /**
   * Convert v4 Message[] to Responses API shape.
   * - System messages are extracted into a single `instructions` string
   *   (concatenated with \n\n if multiple).
   * - User/assistant messages become {type:'message', role, content:[...]} items.
   * - Assistant tool_calls become {type:'function_call', call_id, name, arguments} items.
   * - Tool result messages become {type:'function_call_output', call_id, output} items.
   */
  private translateMessages(messages: Message[]): {
    instructions: string | undefined;
    items: ResponsesInputItem[];
  } {
    const systemParts: string[] = [];
    const items: ResponsesInputItem[] = [];

    for (const msg of messages) {
      switch (msg.role) {
        case 'system':
          systemParts.push(msg.content);
          break;
        case 'user':
          items.push({
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: msg.content }],
          });
          break;
        case 'assistant': {
          if (msg.content) {
            items.push({
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: msg.content }],
            });
          }
          if (msg.toolCalls && msg.toolCalls.length > 0) {
            for (const tc of msg.toolCalls) {
              items.push({
                type: 'function_call',
                call_id: tc.id,
                name: tc.name,
                arguments: JSON.stringify(tc.arguments ?? {}),
              });
            }
          }
          break;
        }
        case 'tool':
          items.push({
            type: 'function_call_output',
            call_id: msg.toolCallId,
            output: msg.content,
          });
          break;
      }
    }

    const instructions = systemParts.length > 0 ? systemParts.join('\n\n') : undefined;
    return { instructions, items };
  }

  private translateTools(tools: ToolSchema[]): ResponsesTool[] {
    return tools.map((t) => ({
      type: 'function' as const,
      name: t.name,
      description: t.description,
      strict: false,
      parameters: t.inputSchema,
    }));
  }

  private parseResponse(json: ResponsesAPIResponse): ProviderCallOutput {
    let output = Array.isArray(json.output) ? json.output : [];

    // Backfill: when stream recovery left output empty but output_text is set,
    // synthesize a message item so downstream parsing has something to read.
    if (output.length === 0 && typeof json.output_text === 'string' && json.output_text.trim()) {
      output = [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: json.output_text.trim() }],
          status: 'completed',
        } as ResponsesOutputMessage,
      ];
    }

    const status = (json.status ?? '').toLowerCase();
    if (status === 'failed' || status === 'cancelled') {
      throw new ProviderError(
        `Provider ${this.providerName} returned status='${status}'`,
        this.providerName,
        undefined,
        json,
      );
    }

    if (output.length === 0) {
      throw new ProviderError(
        `Provider ${this.providerName} returned no output items`,
        this.providerName,
        undefined,
        json,
      );
    }

    const textParts: string[] = [];
    const toolCalls: ToolCallRequest[] = [];

    for (const item of output) {
      const itemType = (item as { type: string }).type;
      const itemStatus =
        typeof (item as { status?: string }).status === 'string'
          ? ((item as { status: string }).status).toLowerCase()
          : undefined;

      if (itemType === 'message') {
        const msg = item as ResponsesOutputMessage;
        const text = (msg.content ?? [])
          .filter((c) => c.type === 'output_text' && typeof c.text === 'string')
          .map((c) => c.text as string)
          .join('');
        if (text) textParts.push(text);
      } else if (itemType === 'function_call') {
        // Skip in-flight items.
        if (itemStatus === 'queued' || itemStatus === 'in_progress' || itemStatus === 'incomplete') {
          continue;
        }
        const fc = item as ResponsesOutputFunctionCall;
        const argsRaw = fc.arguments;
        let args: Record<string, unknown> = {};
        if (typeof argsRaw === 'string') {
          try {
            const parsed = argsRaw.trim() === '' ? {} : JSON.parse(argsRaw);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              args = parsed as Record<string, unknown>;
            }
          } catch {
            console.warn(
              `[${this.providerName}] failed to JSON.parse function_call arguments for ${fc.name}; falling back to {}`,
            );
            args = {};
          }
        } else if (argsRaw && typeof argsRaw === 'object' && !Array.isArray(argsRaw)) {
          args = argsRaw as Record<string, unknown>;
        }
        const callId = (fc.call_id || fc.id || '').trim();
        toolCalls.push({
          id: callId || `call_${Math.random().toString(36).slice(2, 10)}`,
          name: fc.name,
          arguments: args,
        });
      }
      // 'reasoning' items intentionally ignored at v4 minimum scope (Phase 13 will replay them).
    }

    let finishReason: ProviderCallOutput['finishReason'];
    if (toolCalls.length > 0) {
      finishReason = 'tool_use';
    } else if (status === 'incomplete') {
      const reason = json.incomplete_details?.reason;
      finishReason = reason === 'max_output_tokens' ? 'length' : 'stop';
    } else {
      finishReason = 'stop';
    }

    const usage = json.usage ?? {};
    const cachedTokens =
      usage.cached_tokens ?? usage.input_tokens_details?.cached_tokens;

    return {
      content: textParts.length > 0 ? textParts.join('\n') : '',
      toolCalls,
      finishReason,
      usage: {
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        ...(cachedTokens != null ? { cacheReadTokens: cachedTokens } : {}),
      },
      raw: json,
    };
  }

  private async fetchWithTimeout(
    url: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ProviderTimeoutError(this.providerName, this.timeoutMs);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private async safeReadText(response: Response): Promise<string> {
    try {
      return await response.text();
    } catch {
      return '';
    }
  }

  private backoffMs(attempt: number): number {
    return 1000 * attempt;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
