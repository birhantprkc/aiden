/**
 * providers/v4/ollamaPromptToolsAdapter.ts — Aiden v4.0.0
 *
 * Local Ollama adapter with prompt-based fake tool calling.
 *
 * Why this exists: Ollama's native /api/chat tool support varies wildly across
 * models. To make tool calling reliable on small local models (llama3.2,
 * gemma2:2b, qwen2.5:7b, etc.), we don't send `tools` to the API at all —
 * instead we inject a tool catalog into the system prompt and parse
 * `<tool_call>{...}</tool_call>` tags out of the model's text output.
 * This is the same VLLM/Hermes-2-Pro tool format already understood by every
 * Hermes-trained, Qwen, and Llama tool-trained checkpoint.
 *
 * Status: PHASE 4 — non-streaming only.
 *
 * Hermes reference: environments/tool_call_parsers/hermes_parser.py
 *   (Aiden v4 adopts the same `<tool_call>` regex format verbatim.)
 *
 * Wire-format quirks handled here:
 *   1. POST /api/chat with {model, messages, stream:false}; NO `tools` field.
 *   2. System prompt augmented with tool catalog + format instructions
 *      when input.tools.length > 0.
 *   3. Parse response.message.content for <tool_call>{...}</tool_call> blocks.
 *      Multiple blocks → multiple toolCalls. Malformed JSON → warn, skip.
 *   4. Tool calls present → finishReason='tool_use', content stripped to text
 *      preceding first <tool_call>.
 *   5. Tool replies (role='tool') translated to user messages with a
 *      "<tool_response>" wrapper so the model sees them clearly.
 *   6. Token usage: prompt_eval_count → inputTokens, eval_count → outputTokens.
 *   7. Network failure → ProviderError(retryable:true) with "Ollama not reachable".
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
import { ProviderError, ProviderTimeoutError } from './errors';

export interface OllamaPromptToolsAdapterOptions {
  /** Default 'http://localhost:11434'. No trailing slash. */
  baseUrl?: string;
  /** e.g. 'llama3.2', 'qwen2.5:7b', 'gemma2:2b'. */
  model: string;
  /** For error messages and logging. */
  providerName: string;
  /** Per-request timeout. Default 120_000. */
  timeoutMs?: number;
  /** Retries on transient failures. Default 0 — local server, fail fast. */
  maxRetries?: number;
}

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OllamaChatRequest {
  model: string;
  messages: OllamaMessage[];
  stream: false;
  options?: Record<string, unknown>;
}

interface OllamaChatResponse {
  message?: { role: string; content: string };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

const DEFAULT_BASE_URL = 'http://localhost:11434';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RETRIES = 0;

/**
 * Hermes-2-Pro / VLLM tool_call regex.
 * Matches both closed and unclosed tags (truncated generation):
 *   <tool_call>...</tool_call>      → group 1
 *   <tool_call>...                  → group 2 (unclosed at end-of-string)
 */
const TOOL_CALL_PATTERN = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>|<tool_call>\s*([\s\S]*)/g;

export class OllamaPromptToolsAdapter implements ProviderAdapter {
  apiMode: ApiMode = 'ollama_prompt_tools';
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly providerName: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(options: OllamaPromptToolsAdapterOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.model = options.model;
    this.providerName = options.providerName;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  async call(input: ProviderCallInput): Promise<ProviderCallOutput> {
    const body = this.buildRequestBody(input);
    const url = `${this.baseUrl}/api/chat`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    const totalAttempts = this.maxRetries + 1;
    let lastError: ProviderError | null = null;

    for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
      try {
        const response = await this.fetchWithTimeout(url, headers, body);
        if (response.ok) {
          const json = (await response.json()) as OllamaChatResponse;
          return this.parseResponse(json);
        }
        const status = response.status;
        const rawText = await this.safeReadText(response);
        const retryable = status >= 500 || status === 429;
        const err = new ProviderError(
          `Provider ${this.providerName} returned ${status}: ${rawText.slice(0, 500)}`,
          this.providerName,
          status,
          rawText,
          retryable,
        );
        if (!retryable || attempt >= totalAttempts) throw err;
        lastError = err;
        await this.sleep(this.backoffMs(attempt));
      } catch (err) {
        if (err instanceof ProviderError && !err.retryable) throw err;
        if (err instanceof ProviderTimeoutError) {
          lastError = err;
          if (attempt < totalAttempts) {
            await this.sleep(this.backoffMs(attempt));
            continue;
          }
          throw err;
        }
        if (err instanceof ProviderError) {
          lastError = err;
          if (attempt < totalAttempts) {
            await this.sleep(this.backoffMs(attempt));
            continue;
          }
          throw err;
        }
        // Network-level failure (fetch threw). Most common: connection refused.
        const wrapped = new ProviderError(
          `Ollama not reachable at ${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
          this.providerName,
          undefined,
          err,
          true,
        );
        if (attempt < totalAttempts) {
          lastError = wrapped;
          await this.sleep(this.backoffMs(attempt));
          continue;
        }
        throw wrapped;
      }
    }

    throw lastError ?? new ProviderError(
      `Provider ${this.providerName} exhausted retries`,
      this.providerName,
    );
  }

  private buildRequestBody(input: ProviderCallInput): OllamaChatRequest {
    const messages = this.translateMessages(input.messages, input.tools);
    const body: OllamaChatRequest = {
      model: this.model,
      messages,
      stream: false,
    };
    const options: Record<string, unknown> = {};
    if (input.maxTokens != null) options.num_predict = input.maxTokens;
    if (input.temperature != null) options.temperature = input.temperature;
    if (input.extraBody && typeof input.extraBody === 'object') {
      Object.assign(options, input.extraBody);
    }
    if (Object.keys(options).length > 0) body.options = options;
    return body;
  }

  /**
   * Convert v4 Message[] to Ollama messages, injecting the tool catalog
   * into / prepending a system message when tools are provided.
   */
  private translateMessages(messages: Message[], tools: ToolSchema[]): OllamaMessage[] {
    const out: OllamaMessage[] = [];
    const toolPrompt = tools.length > 0 ? this.buildToolPrompt(tools) : '';

    let toolPromptInjected = false;

    for (const msg of messages) {
      switch (msg.role) {
        case 'system': {
          const augmented =
            !toolPromptInjected && toolPrompt
              ? `${msg.content}\n\n${toolPrompt}`
              : msg.content;
          out.push({ role: 'system', content: augmented });
          if (toolPrompt) toolPromptInjected = true;
          break;
        }
        case 'user':
          out.push({ role: 'user', content: msg.content });
          break;
        case 'assistant': {
          // Re-serialize prior tool calls back into <tool_call> tags so the
          // model sees its own canonical history.
          let body = msg.content ?? '';
          if (msg.toolCalls && msg.toolCalls.length > 0) {
            const calls = msg.toolCalls.map((tc) =>
              `<tool_call>${JSON.stringify({ name: tc.name, arguments: tc.arguments ?? {} })}</tool_call>`,
            );
            body = body ? `${body}\n${calls.join('\n')}` : calls.join('\n');
          }
          out.push({ role: 'assistant', content: body });
          break;
        }
        case 'tool':
          // Ollama has no native 'tool' role — wrap the result so the model
          // can clearly see which call_id it is responding to.
          out.push({
            role: 'user',
            content: `<tool_response id="${msg.toolCallId}">\n${msg.content}\n</tool_response>`,
          });
          break;
      }
    }

    // Edge case: tools provided but no system message in conversation.
    // Insert a synthetic system message at the head so the model sees the catalog.
    if (toolPrompt && !toolPromptInjected) {
      out.unshift({ role: 'system', content: toolPrompt });
    }

    return out;
  }

  private buildToolPrompt(tools: ToolSchema[]): string {
    const catalog = tools
      .map((t) =>
        JSON.stringify({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema,
        }),
      )
      .join('\n');
    return [
      'You have access to the following tools. To call a tool, output exactly:',
      '<tool_call>{"name": "<tool_name>", "arguments": {...}}</tool_call>',
      'You may emit multiple <tool_call> blocks in one turn. After the final closing tag, emit nothing else.',
      'If no tool is needed, respond directly with text.',
      '',
      'Tools:',
      catalog,
    ].join('\n');
  }

  private parseResponse(json: OllamaChatResponse): ProviderCallOutput {
    const message = json.message;
    const rawContent = message?.content ?? '';

    const { textBefore, toolCalls } = this.extractToolCalls(rawContent);

    let finishReason: ProviderCallOutput['finishReason'];
    if (toolCalls.length > 0) {
      finishReason = 'tool_use';
    } else if (json.done_reason === 'length') {
      finishReason = 'length';
    } else {
      finishReason = 'stop';
    }

    return {
      content: toolCalls.length > 0 ? textBefore : rawContent,
      toolCalls,
      finishReason,
      usage: {
        inputTokens: json.prompt_eval_count ?? 0,
        outputTokens: json.eval_count ?? 0,
      },
      raw: json,
    };
  }

  /**
   * Pull <tool_call> JSON blobs out of model text.
   * Returns:
   *   - textBefore: text up to (but not including) the first <tool_call> tag.
   *   - toolCalls: parsed tool calls (skips malformed blocks with a warning).
   */
  private extractToolCalls(text: string): {
    textBefore: string;
    toolCalls: ToolCallRequest[];
  } {
    if (!text.includes('<tool_call>')) {
      return { textBefore: text, toolCalls: [] };
    }

    const toolCalls: ToolCallRequest[] = [];
    const pattern = new RegExp(TOOL_CALL_PATTERN.source, 'g');
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text)) !== null) {
      const raw = (match[1] ?? match[2] ?? '').trim();
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as { name?: string; arguments?: unknown };
        if (typeof parsed.name !== 'string' || !parsed.name) {
          console.warn(
            `[${this.providerName}] tool_call missing 'name' field; skipping. raw=${raw.slice(0, 100)}`,
          );
          continue;
        }
        const args =
          parsed.arguments != null &&
          typeof parsed.arguments === 'object' &&
          !Array.isArray(parsed.arguments)
            ? (parsed.arguments as Record<string, unknown>)
            : {};
        toolCalls.push({
          id: `call_${Math.random().toString(36).slice(2, 10)}`,
          name: parsed.name,
          arguments: args,
        });
      } catch {
        console.warn(
          `[${this.providerName}] failed to JSON.parse tool_call body; skipping. raw=${raw.slice(0, 100)}`,
        );
      }
    }

    const firstTagIdx = text.indexOf('<tool_call>');
    const textBefore = firstTagIdx >= 0 ? text.slice(0, firstTagIdx).trim() : text;

    return { textBefore, toolCalls };
  }

  private async fetchWithTimeout(
    url: string,
    headers: Record<string, string>,
    body: OllamaChatRequest,
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
    return 500 * attempt;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
