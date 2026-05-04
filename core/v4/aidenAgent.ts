/**
 * core/v4/aidenAgent.ts — Aiden v4.0.0
 *
 * THE single tool-calling loop. Replaces planner+responder.
 *
 * Status: PHASE 2 — loop core implementation. Provider adapters land in Phase 3,
 *   tool execution in Phase 6+, prompt builder in Phase 12.
 *
 * Hermes reference: hermes-agent/run_agent.py
 *   - AIAgent class                                L873
 *   - AIAgent.run_conversation()                   L10382
 *   - AIAgent._execute_tool_calls_sequential()     L9779
 *   - AIAgent._execute_tool_calls_concurrent()     L9400 (deferred to v4.1)
 *   - AIAgent._handle_max_iterations()             L10191
 *   - IterationBudget class                        L271
 *   - Fallback chain wiring                        L1558+
 *
 * Why this file is the architectural fix for fabrication:
 *   v3 split intent→plan→execute→respond across two LLMs. The responder
 *   never saw raw tool outputs and routinely hallucinated them. Here, ONE
 *   LLM drives the loop: tool results are appended to its own message
 *   history before its next call, so the LLM that writes the final response
 *   literally has the tool outputs in its context window.
 */

import {
  Message,
  ToolSchema,
  ToolCallRequest,
  ToolCallResult,
  ProviderAdapter,
  ProviderCallOutput,
} from '../../providers/v4/types';
import type {
  PlannerGuard,
  PlannerGuardDecision,
} from '../../moat/plannerGuard';
import type {
  HonestyEnforcement,
  HonestyFinding,
  HonestyTraceEntry,
} from '../../moat/honestyEnforcement';
import type {
  SkillTeacher,
  SkillProposalCallbacks,
  SkillTeacherTraceEntry,
} from '../../moat/skillTeacher';

/**
 * Tool executor — runs a single tool call and returns the result.
 *
 * Implementation lives in the tool registry (Phase 6+). For Phase 2 tests,
 * this is mocked. The executor MUST NOT throw for tool-level errors; instead
 * return a `ToolCallResult` with `error` populated. The loop catches throws
 * defensively and converts them to error results so the model can recover.
 */
export type ToolExecutor = (call: ToolCallRequest) => Promise<ToolCallResult>;

/**
 * One-shot fallback strategy. Called once per conversation when the primary
 * provider throws. Returning a new adapter swaps it in for the rest of the
 * turn; returning null propagates the error. Models the Hermes
 * `_fallback_chain` behaviour but simplified: v4 Phase 2 supports one
 * activation per `runConversation`. Multi-step chains land in a later phase.
 */
export interface FallbackStrategy {
  activate(error: Error, attempt: number): Promise<ProviderAdapter | null>;
}

export interface AidenAgentOptions {
  provider: ProviderAdapter;
  toolExecutor: ToolExecutor;
  tools: ToolSchema[];
  /** Hard cap on assistant turns. Hermes default is 90. */
  maxTurns?: number;
  fallback?: FallbackStrategy;
  /** Observability hook — invoked before and after each tool call. */
  onToolCall?: (
    call: ToolCallRequest,
    phase: 'before' | 'after',
    result?: ToolCallResult,
  ) => void;
  /** Fired once when crossing 70% of budget (caution) and once at 90% (warning). */
  onBudgetWarning?: (
    level: 'caution' | 'warning',
    turn: number,
    max: number,
  ) => void;
  /** Phase 12: pre-loop tool subset classifier (Aiden moat). */
  plannerGuard?: PlannerGuard;
  /** Phase 12: fired with the PlannerGuard decision before the loop runs. */
  onPlannerGuardDecision?: (decision: PlannerGuardDecision) => void;
  /** Phase 12: post-loop trace verifier (Aiden moat). */
  honestyEnforcement?: HonestyEnforcement;
  /** Phase 12: skill workflow proposer (Aiden moat). */
  skillTeacher?: SkillTeacher;
  /** Phase 12: callbacks the SkillTeacher uses when proposing. */
  skillTeacherCallbacks?: SkillProposalCallbacks;
  /** Phase 12: per-tool verification flag lookup. Allows the loop to feed
   *  Honesty's verified-flag check (memory tools) without coupling the
   *  registry to Honesty. The function receives the just-completed tool
   *  call's result and returns true/false/undefined. */
  resolveVerifiedFlag?: (result: ToolCallResult) => boolean | undefined;
  /** Phase 12: lookup function for tool→toolset mapping (used by
   *  SkillTeacher to compute toolset diversity for proposals). */
  resolveToolset?: (toolName: string) => string | undefined;
}

export interface AidenAgentResult {
  finalContent: string;
  /** Full conversation including assistant tool_calls and tool results. */
  messages: Message[];
  turnCount: number;
  toolCallCount: number;
  fallbackActivated: boolean;
  finishReason: 'stop' | 'budget_exhausted' | 'error';
  totalUsage: {
    inputTokens: number;
    outputTokens: number;
  };
  /** Phase 12: every tool call this turn, in order, with verified flag
   *  filled by `resolveVerifiedFlag` (when wired). Always present, even
   *  if the moat layers are not configured. */
  toolCallTrace: HonestyTraceEntry[];
  /** Phase 12: populated when HonestyEnforcement detected failed claims. */
  honestyFindings?: HonestyFinding[];
  /** Phase 12: name of the skill SkillTeacher created this turn (if any). */
  skillCreated?: string;
}

const DEFAULT_MAX_TURNS = 90;
const CAUTION_FRACTION = 0.7;
const WARNING_FRACTION = 0.9;

export class AidenAgent {
  private provider: ProviderAdapter;
  private readonly toolExecutor: ToolExecutor;
  private readonly tools: ToolSchema[];
  private readonly maxTurns: number;
  private readonly fallback?: FallbackStrategy;
  private readonly onToolCall?: AidenAgentOptions['onToolCall'];
  private readonly onBudgetWarning?: AidenAgentOptions['onBudgetWarning'];
  private readonly plannerGuard?: PlannerGuard;
  private readonly onPlannerGuardDecision?: AidenAgentOptions['onPlannerGuardDecision'];
  private readonly honestyEnforcement?: HonestyEnforcement;
  private readonly skillTeacher?: SkillTeacher;
  private readonly skillTeacherCallbacks?: SkillProposalCallbacks;
  private readonly resolveVerifiedFlag?: AidenAgentOptions['resolveVerifiedFlag'];
  private readonly resolveToolset?: AidenAgentOptions['resolveToolset'];

  constructor(options: AidenAgentOptions) {
    this.provider = options.provider;
    this.toolExecutor = options.toolExecutor;
    this.tools = options.tools;
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    this.fallback = options.fallback;
    this.onToolCall = options.onToolCall;
    this.onBudgetWarning = options.onBudgetWarning;
    this.plannerGuard = options.plannerGuard;
    this.onPlannerGuardDecision = options.onPlannerGuardDecision;
    this.honestyEnforcement = options.honestyEnforcement;
    this.skillTeacher = options.skillTeacher;
    this.skillTeacherCallbacks = options.skillTeacherCallbacks;
    this.resolveVerifiedFlag = options.resolveVerifiedFlag;
    this.resolveToolset = options.resolveToolset;
  }

  async runConversation(initialMessages: Message[]): Promise<AidenAgentResult> {
    const messages: Message[] = [...initialMessages];
    let turnCount = 0;
    let toolCallCount = 0;
    let fallbackActivated = false;
    let finishReason: 'stop' | 'budget_exhausted' | 'error' = 'stop';
    let finalContent = '';
    const totalUsage = { inputTokens: 0, outputTokens: 0 };
    const toolCallTrace: HonestyTraceEntry[] = [];

    // ── Phase 12 layer 1: PlannerGuard (pre-loop tool subset) ────────
    let activeTools: ToolSchema[] = this.tools;
    if (this.plannerGuard) {
      const lastUser = lastUserMessage(initialMessages);
      const decision = await this.plannerGuard.decide(
        lastUser,
        initialMessages,
      );
      this.onPlannerGuardDecision?.(decision);
      const allowed = new Set(decision.selectedTools);
      // Only narrow if the guard actually returned something useful and
      // we have schemas to filter against.
      if (allowed.size > 0 && this.tools.length > 0) {
        const narrowed = this.tools.filter((t) => allowed.has(t.name));
        // Defensive: never strip everything (preserves the "narrow only"
        // contract). If filter accidentally empties, keep full list.
        if (narrowed.length > 0) activeTools = narrowed;
      }
    }

    const cautionThreshold = Math.floor(this.maxTurns * CAUTION_FRACTION);
    const warningThreshold = Math.floor(this.maxTurns * WARNING_FRACTION);
    let cautionFired = false;
    let warningFired = false;

    while (turnCount < this.maxTurns) {
      turnCount += 1;

      if (!cautionFired && turnCount >= cautionThreshold) {
        cautionFired = true;
        this.onBudgetWarning?.('caution', turnCount, this.maxTurns);
      }
      if (!warningFired && turnCount >= warningThreshold) {
        warningFired = true;
        this.onBudgetWarning?.('warning', turnCount, this.maxTurns);
      }

      let output: ProviderCallOutput;
      try {
        output = await this.provider.call({
          messages,
          tools: activeTools,
        });
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (!fallbackActivated && this.fallback) {
          const swapped = await this.fallback.activate(error, turnCount);
          if (swapped) {
            this.provider = swapped;
            fallbackActivated = true;
            // Re-attempt this turn with the new provider. Decrement turn so
            // the swap doesn't count against the budget — matches Hermes
            // _activate_fallback semantics.
            turnCount -= 1;
            continue;
          }
        }
        finishReason = 'error';
        throw error;
      }

      totalUsage.inputTokens += output.usage.inputTokens;
      totalUsage.outputTokens += output.usage.outputTokens;

      const hasToolCalls = output.toolCalls && output.toolCalls.length > 0;

      // Append the assistant turn to history. Even content-only assistant
      // messages are appended so the conversation record is complete.
      const assistantMessage: Message = {
        role: 'assistant',
        content: output.content ?? '',
        ...(hasToolCalls ? { toolCalls: output.toolCalls } : {}),
      };
      messages.push(assistantMessage);

      // Termination: model says stop AND emitted no tool calls.
      // (If finishReason is 'tool_use' but toolCalls is empty, treat as stop —
      // a known provider quirk; logging hook can be wired later.)
      if (!hasToolCalls) {
        finalContent = output.content ?? '';
        finishReason = 'stop';
        return await this.finalize({
          finalContent,
          messages,
          turnCount,
          toolCallCount,
          fallbackActivated,
          finishReason,
          totalUsage,
          toolCallTrace,
          aborted: false,
        });
      }

      // Dispatch tool calls sequentially. Parallel execution
      // (Hermes _execute_tool_calls_concurrent) is deferred to v4.1.
      for (const call of output.toolCalls) {
        toolCallCount += 1;
        this.onToolCall?.(call, 'before');

        let result: ToolCallResult;
        try {
          result = await this.toolExecutor(call);
        } catch (err) {
          // Tool throws don't crash the loop. The model sees the error in
          // its context and decides what to do — Hermes pattern.
          const message = err instanceof Error ? err.message : String(err);
          result = { id: call.id, name: call.name, result: null, error: message };
        }

        this.onToolCall?.(call, 'after', result);

        // Phase 12: append to trace BEFORE tool message goes onto history.
        toolCallTrace.push({
          name: call.name,
          result: result.result,
          error: result.error,
          verified: this.resolveVerifiedFlag?.(result),
        });

        const toolContent = result.error
          ? `Error: ${result.error}`
          : typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);

        messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: toolContent,
        });
      }
    }

    // Budget exhausted — return partial result. The last assistant message
    // (if any) becomes the final content; otherwise empty string.
    finishReason = 'budget_exhausted';
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      if (msg.role === 'assistant' && msg.content) {
        finalContent = msg.content;
        break;
      }
    }
    return await this.finalize({
      finalContent,
      messages,
      turnCount,
      toolCallCount,
      fallbackActivated,
      finishReason,
      totalUsage,
      toolCallTrace,
      aborted: true,
    });
  }

  /**
   * Phase 12: post-loop pass — runs HonestyEnforcement against the trace,
   * runs SkillTeacher observation, and assembles the final result.
   *
   * The two layers compose without coupling: Honesty runs first because it
   * may rewrite `finalContent` (which SkillTeacher does NOT inspect — it
   * only looks at the trace + user messages). Layer order matters and is
   * intentional.
   */
  private async finalize(args: {
    finalContent: string;
    messages: Message[];
    turnCount: number;
    toolCallCount: number;
    fallbackActivated: boolean;
    finishReason: 'stop' | 'budget_exhausted' | 'error';
    totalUsage: { inputTokens: number; outputTokens: number };
    toolCallTrace: HonestyTraceEntry[];
    aborted: boolean;
  }): Promise<AidenAgentResult> {
    let finalContent = args.finalContent;
    let honestyFindings: HonestyFinding[] | undefined;
    let skillCreated: string | undefined;

    // ── Phase 12 layer 2: HonestyEnforcement ──────────────────────
    if (this.honestyEnforcement && finalContent) {
      const honesty = await this.honestyEnforcement.check(
        finalContent,
        args.messages,
        args.toolCallTrace,
      );
      if (!honesty.passed) {
        if (honesty.correctedResponse) {
          finalContent = honesty.correctedResponse;
        }
        honestyFindings = honesty.findings;
      }
    }

    // ── Phase 12 layer 3: SkillTeacher observation ────────────────
    if (this.skillTeacher) {
      const teacherTrace: SkillTeacherTraceEntry[] = args.toolCallTrace.map(
        (t) => ({
          name: t.name,
          args: {},
          result: t.result,
          error: t.error,
          toolset: this.resolveToolset?.(t.name),
        }),
      );
      const proposal = await this.skillTeacher.observeTurn(
        args.messages,
        teacherTrace,
        args.aborted,
      );
      if (proposal) {
        const decision = await this.skillTeacher.handleProposal(
          proposal,
          this.skillTeacherCallbacks ?? {},
        );
        if (decision.created && decision.skillName) {
          skillCreated = decision.skillName;
        }
      }
    }

    return {
      finalContent,
      messages: args.messages,
      turnCount: args.turnCount,
      toolCallCount: args.toolCallCount,
      fallbackActivated: args.fallbackActivated,
      finishReason: args.finishReason,
      totalUsage: args.totalUsage,
      toolCallTrace: args.toolCallTrace,
      ...(honestyFindings ? { honestyFindings } : {}),
      ...(skillCreated ? { skillCreated } : {}),
    };
  }
}

function lastUserMessage(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role === 'user') return m.content;
  }
  return '';
}
