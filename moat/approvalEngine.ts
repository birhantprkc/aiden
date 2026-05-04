/**
 * moat/approvalEngine.ts — Aiden v4.0.0
 *
 * The central gate every write/execute tool passes through. Three modes:
 *
 *   manual (default) — every mutating call prompts the user via
 *                      `callbacks.promptUser`. Read tools never gate.
 *   smart            — calls auxiliary `callbacks.riskAssess` for
 *                      flagged commands. safe → auto-allow,
 *                      dangerous → auto-deny, caution → prompt.
 *   off              — YOLO. Everything auto-allows. Decision is
 *                      still logged via `callbacks.onDecision`.
 *
 * Allowlist scoping:
 *   - `allowForSession(tool, sig)`        — cleared on `resetSession()`.
 *   - `allowAlways(tool, sig)`            — fired through the optional
 *                                            `callbacks.persistAllow`
 *                                            sink (Phase 6 ConfigManager
 *                                            wires this up; for Phase 9
 *                                            the in-memory entry is the
 *                                            same as the session list).
 *
 * Hermes reference: tools/approval.py — same shape, smaller scope (no
 * heartbeat/HTTP approval surface yet; that lands in Phase 14-15 TUI).
 *
 * Status: PHASE 9.
 */

export type ApprovalMode = 'manual' | 'smart' | 'off';
export type ApprovalDecision =
  | 'allow'
  | 'deny'
  | 'allow_session'
  | 'allow_always';
export type RiskTier = 'safe' | 'caution' | 'dangerous';
export type ToolCategory =
  | 'read'
  | 'write'
  | 'execute'
  | 'network'
  | 'browser';

export interface ApprovalRequest {
  toolName: string;
  category: ToolCategory;
  args: Record<string, unknown>;
  /** Pre-flagged risk tier from the dangerous-patterns catalog. */
  riskTier?: RiskTier;
  /** Why was this flagged? (description from the matching pattern) */
  reason?: string;
}

export interface ApprovalCallbacks {
  /** Called when the user must decide. CLI implements this with a prompt. */
  promptUser?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  /** Smart-mode auxiliary risk assessment (auxiliary LLM). */
  riskAssess?: (req: ApprovalRequest) => Promise<{
    tier: RiskTier;
    rationale: string;
  }>;
  /** Logging hook — fired AFTER every decision (allow or deny). */
  onDecision?: (req: ApprovalRequest, decision: ApprovalDecision) => void;
  /** Permanent-allowlist sink. Phase 6 ConfigManager wires this up. */
  persistAllow?: (toolName: string, argSignature: string) => void;
}

/** Stable signature for an approval request (for allowlist matching). */
export function argSignature(
  toolName: string,
  args: Record<string, unknown>,
): string {
  // Extract the primary mutating argument so we don't bloat the
  // signature with timeouts / cwd / etc. that don't change risk.
  const primary =
    (args.command as string) ??
    (args.path as string) ??
    (args.url as string) ??
    (args.code as string) ??
    '';
  return `${toolName}::${(primary || JSON.stringify(args)).slice(0, 200)}`;
}

export class ApprovalEngine {
  private sessionAllow = new Set<string>();
  private permanentAllow = new Set<string>();

  constructor(
    private mode: ApprovalMode = 'manual',
    private callbacks: ApprovalCallbacks = {},
  ) {}

  setMode(mode: ApprovalMode): void {
    this.mode = mode;
  }

  getMode(): ApprovalMode {
    return this.mode;
  }

  allowForSession(toolName: string, signature: string): void {
    this.sessionAllow.add(`${toolName}::${signature}`);
  }

  allowAlways(toolName: string, signature: string): void {
    const key = `${toolName}::${signature}`;
    this.permanentAllow.add(key);
    this.sessionAllow.add(key); // permanent ⊂ session
    this.callbacks.persistAllow?.(toolName, signature);
  }

  resetSession(): void {
    this.sessionAllow = new Set(this.permanentAllow);
  }

  /**
   * Main entry. Returns `true` to allow, `false` to deny. Read-only
   * categories are always allowed without consulting any callback.
   */
  async checkApproval(req: ApprovalRequest): Promise<boolean> {
    if (req.category === 'read') {
      this.callbacks.onDecision?.(req, 'allow');
      return true;
    }

    // YOLO mode: auto-allow but log.
    if (this.mode === 'off') {
      this.callbacks.onDecision?.(req, 'allow');
      return true;
    }

    // Allowlist short-circuit.
    const sig = argSignature(req.toolName, req.args);
    const key = `${req.toolName}::${sig}`;
    if (this.sessionAllow.has(key)) {
      this.callbacks.onDecision?.(req, 'allow_session');
      return true;
    }

    if (this.mode === 'smart') {
      // Smart mode: trust the pre-flagged tier, otherwise ask the LLM.
      let tier: RiskTier = req.riskTier ?? 'safe';
      let rationale: string | undefined;
      if (!req.riskTier && this.callbacks.riskAssess) {
        const assessed = await this.callbacks.riskAssess(req);
        tier = assessed.tier;
        rationale = assessed.rationale;
      }
      if (tier === 'safe') {
        this.callbacks.onDecision?.(req, 'allow');
        return true;
      }
      if (tier === 'dangerous') {
        this.callbacks.onDecision?.(
          { ...req, reason: rationale ?? req.reason },
          'deny',
        );
        return false;
      }
      // 'caution' falls through to user prompt.
      req = { ...req, riskTier: tier, reason: rationale ?? req.reason };
    }

    // manual or smart-caution → prompt user.
    if (!this.callbacks.promptUser) {
      // No prompter wired (e.g. tests with no UI). Fail-closed.
      this.callbacks.onDecision?.(req, 'deny');
      return false;
    }
    const decision = await this.callbacks.promptUser(req);
    this.callbacks.onDecision?.(req, decision);

    if (decision === 'deny') return false;
    if (decision === 'allow') return true;
    if (decision === 'allow_session') {
      this.allowForSession(req.toolName, sig);
      return true;
    }
    if (decision === 'allow_always') {
      this.allowAlways(req.toolName, sig);
      return true;
    }
    return false;
  }
}
