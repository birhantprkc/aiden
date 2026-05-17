/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/update/registryClient.ts — v4.5 update system.
 *
 * Q-U1(c) two-source strategy:
 *
 *   1. npm registry — `registry.npmjs.org/aiden-runtime/latest` →
 *      `{ version, dist.tarball, _id, ... }`. No auth, fast, the
 *      authoritative source for "what's the newest published version".
 *
 *   2. GitHub releases — `api.github.com/repos/taracodlabs/aiden/
 *      releases/latest` → rich markdown body for the user-facing
 *      "What's new" line. Optional; falls through gracefully when
 *      anonymous-rate-limited or the repo doesn't mirror npm tags.
 *
 * Both fetches share a 4-second timeout per request. Network failure
 * on either side returns null rather than throwing — the boot prompt
 * just won't include release-notes context when we couldn't fetch it.
 */

const NPM_REGISTRY_URL    = 'https://registry.npmjs.org/aiden-runtime/latest';
const GITHUB_RELEASES_URL = 'https://api.github.com/repos/taracodlabs/aiden/releases/latest';
const REGISTRY_TIMEOUT_MS = 4_000;

/** Result of a successful npm registry probe. */
export interface RegistryProbe {
  version:    string;
  tarballUrl?: string;
}

/** Result of a successful GitHub releases probe. */
export interface ReleaseNotes {
  /** Tag name from GitHub release (e.g. `v4.5.0`). */
  tag:    string;
  /** URL of the release page (user-clickable in modern terminals). */
  url:    string;
  /** First ~120 chars of the release body, single-line. */
  blurb:  string;
}

export interface FetchUpdateOptions {
  /** Override npm fetch — tests inject. */
  npmFetch?:    () => Promise<RegistryProbe | null>;
  /** Override GitHub fetch — tests inject. */
  githubFetch?: () => Promise<ReleaseNotes | null>;
  /** Override timeout. Default 4s per request. */
  timeoutMs?:   number;
}

/**
 * Probe both sources in parallel. Returns whatever succeeded; either
 * (or both) may be null on network failure.
 */
export async function fetchUpdateInfo(
  opts: FetchUpdateOptions = {},
): Promise<{ probe: RegistryProbe | null; notes: ReleaseNotes | null }> {
  const npmFetch    = opts.npmFetch    ?? (() => defaultNpmFetch(opts.timeoutMs));
  const githubFetch = opts.githubFetch ?? (() => defaultGithubFetch(opts.timeoutMs));
  const [probe, notes] = await Promise.all([
    npmFetch().catch(() => null),
    githubFetch().catch(() => null),
  ]);
  return { probe, notes };
}

// ── Default fetchers ──────────────────────────────────────────────────────

async function defaultNpmFetch(timeoutMs = REGISTRY_TIMEOUT_MS): Promise<RegistryProbe | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(NPM_REGISTRY_URL, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'aiden-runtime update check',
      },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { version?: unknown; dist?: { tarball?: unknown } };
    if (typeof json.version !== 'string') return null;
    return {
      version:    json.version,
      tarballUrl: typeof json.dist?.tarball === 'string' ? json.dist.tarball : undefined,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function defaultGithubFetch(timeoutMs = REGISTRY_TIMEOUT_MS): Promise<ReleaseNotes | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(GITHUB_RELEASES_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'aiden-runtime update check',
      },
      signal: controller.signal,
    });
    // 404 = repo doesn't expose releases yet; 403 = anonymous rate limit.
    // Both → null + boot proceeds without notes.
    if (!res.ok) return null;
    const json = (await res.json()) as {
      tag_name?:     unknown;
      html_url?:     unknown;
      body?:         unknown;
    };
    if (typeof json.tag_name !== 'string') return null;
    const body = typeof json.body === 'string' ? json.body : '';
    return {
      tag:    json.tag_name,
      url:    typeof json.html_url === 'string' ? json.html_url : '',
      blurb:  firstLineOf(body, 120),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** First non-blank line of a multi-line string, truncated to maxChars. */
export function firstLineOf(text: string, maxChars: number): string {
  if (typeof text !== 'string' || text.length === 0) return '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    // Skip markdown heading lines (`## What's new` etc.) so the blurb
    // is actually descriptive prose, not a section heading.
    if (line.length === 0 || line.startsWith('#')) continue;
    if (line.length <= maxChars) return line;
    return line.slice(0, maxChars - 1) + '…';
  }
  return '';
}
