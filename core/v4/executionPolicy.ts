/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/executionPolicy.ts — v4.12 SH.1 (unified, HONEST policy read-model).
 *
 * A single coherent view over the currently-scattered guards (sandbox file
 * ACLs/denylist + approval mode + SSRF network guard + dangerous-command
 * classifier). This is a READ-MODEL — it does NOT add or rebuild enforcement;
 * it reports what the existing enforcement points do, and is HONEST about which
 * guards are physical containment vs advisory defense-in-depth.
 *
 * ★ Anti-self-deception (the whole point of SH.1): the file-access guards are
 * enforced by the file_* tools ONLY — `shell_exec` never consults them. So under
 * the LOCAL backend there is NO process containment; the file guards are
 * defense-in-depth, and this object says so (`containment`, `fileGuardsAdvisory`,
 * `notes`). A real floor exists only under the Docker backend (SH.2 hardens it).
 */
import type { SandboxConfig } from './sandboxConfig';

export type NetworkPolicy = 'none' | 'public' | 'allowlist' | 'full';
export type ShellPolicy = 'none' | 'safe' | 'ask-dangerous' | 'full';
export type SideEffectPolicy = 'deny' | 'ask' | 'allow';
export type ApprovalMode = 'manual' | 'smart' | 'off';

export interface ExecutionPolicy {
  /** File roots the file_* tools allow (advisory — see fileGuardsAdvisory). */
  readRoots: string[];
  writeRoots: string[];
  /** Credential/system paths the file_* tools deny (advisory defense-in-depth). */
  deniedPaths: string[];
  network: NetworkPolicy;
  shell: ShellPolicy;
  externalSideEffects: SideEffectPolicy;
  secrets: 'deny-direct-read';
  approvalMode: ApprovalMode;
  /** ★ Physical process floor: 'none' (local backend) or 'docker'. */
  containment: 'none' | 'docker';
  /** ★ True when shell can bypass the file guards (local backend) — they are
   *  then defense-in-depth for file_* tools, NOT containment. */
  fileGuardsAdvisory: boolean;
  /** Honest caveats surfaced to the user / reasoned over by the agent. */
  notes: string[];
}

export interface PolicyInputs {
  sandbox: SandboxConfig;
  approvalMode: ApprovalMode;
  /** Whether the SSRF/network guard is wired for network-category tools. */
  ssrfEnabled: boolean;
}

/** Build the honest, unified policy view. Pure — no enforcement, no I/O. */
export function describeExecutionPolicy(inputs: PolicyInputs): ExecutionPolicy {
  const { sandbox, approvalMode, ssrfEnabled } = inputs;

  const containment: 'none' | 'docker' =
    sandbox.enabled && sandbox.defaultBackend === 'docker' ? 'docker' : 'none';
  const fileGuardsAdvisory = containment === 'none';

  const shell: ShellPolicy = approvalMode === 'off' ? 'full' : 'ask-dangerous';
  const externalSideEffects: SideEffectPolicy = approvalMode === 'off' ? 'allow' : 'ask';
  const network: NetworkPolicy =
    containment === 'docker' && sandbox.networkMode === 'none' ? 'none'
      : ssrfEnabled ? 'public'   // SSRF blocks private/loopback targets; public allowed
      : 'full';

  const notes: string[] = [];
  if (containment === 'none') {
    notes.push(
      'No process containment (local backend): shell_exec can reach the filesystem and network directly. ' +
      'The file-access guards below are DEFENSE-IN-DEPTH for file_* tools only — they do NOT contain the shell.',
    );
  } else {
    notes.push(
      'Shell runs in a Docker container (a real process floor). Note: the current container is only weakly ' +
      'hardened (writable working-dir mount, default network) — SH.2 hardens it.',
    );
  }
  notes.push('Credential/system denylist + file roots apply to file_* tools; a shell command can bypass them under the local backend.');

  return {
    readRoots: [...sandbox.fsAllowList],
    writeRoots: [...sandbox.fsAllowList],
    deniedPaths: [...sandbox.fsDenyList],
    network,
    shell,
    externalSideEffects,
    secrets: 'deny-direct-read',
    approvalMode,
    containment,
    fileGuardsAdvisory,
    notes,
  };
}

/** One-line honest summary for a status surface. */
export function summarizeExecutionPolicy(p: ExecutionPolicy): string {
  const floor = p.containment === 'docker' ? 'Docker (weak)' : 'none (local — file guards are advisory, NOT containment)';
  return `containment=${floor} · approval=${p.approvalMode} · shell=${p.shell} · network=${p.network} · secrets=${p.secrets}`;
}
