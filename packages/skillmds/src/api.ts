// Registry client. Mirrors the api() helper in bin/skillmd-mcp.mjs, injecting
// the resolved base URL + bearer token.
import { createHash } from "node:crypto";
import { isAllowedSourceUrl } from "@skillmds/core";
import { FETCH_TIMEOUT_MS, MAX_PACK_BYTES, MAX_PACK_FILES } from "./limits.js";
import { resolveApi, resolveToken, realSources, hostOf, DEFAULT_API } from "./config.js";
import { IntegrityError, RegistryError } from "./errors.js";
import { describeFailure, retryingFetch } from "./retry.js";
import type { RetryOptions } from "./retry.js";
import type { GlobalFlags, ResolveSources } from "./config.js";

// SKILL.md materialization + the companion-file SSRF guard live in
// @skillmds/core so the CLI and the MCP server share one implementation.
export { isAllowedSourceUrl, reconstructSkillMd, skillMdFor } from "@skillmds/core";
export { IntegrityError, RegistryError };

export interface ClientOptions {
  fetch?: typeof fetch;
  sources?: ResolveSources;
  timeoutMs?: number;
  /** Ride out a busy registry: retry 429/502/503/504 and network errors (see
   *  retry.ts). Absent, a request is made once, as it always was. Each attempt
   *  gets its own timeout. */
  retry?: RetryOptions;
}

/** Why a request never got an answer, in words: the timeout named, else the
 *  underlying cause (DNS, refused connection, proxy denial). */
function networkReason(e: unknown, timeoutMs: number): string {
  const cause = e instanceof Error ? ((e.cause as Error | undefined)?.message ?? e.message) : String(e);
  // AbortSignal.timeout surfaces either as a bare TimeoutError (DOMException)
  // or wrapped in a TypeError("fetch failed") whose cause is the TimeoutError.
  const isTimeout = e instanceof Error && (e.name === "TimeoutError" || (e.cause instanceof Error && e.cause.name === "TimeoutError"));
  return isTimeout ? `timed out after ${Math.round(timeoutMs / 1000)}s` : cause;
}

/** A failed request as the RegistryError a caller can read the status from.
 *  One the retry helper already made (a rate limit, say) passes through. */
function asRegistryError(e: unknown, base: string, timeoutMs: number): RegistryError {
  return e instanceof RegistryError ? e : new RegistryError(`could not reach ${base}: ${networkReason(e, timeoutMs)}`);
}

/** fetch with a hard deadline. Node >=18 supports AbortSignal.timeout. */
export function timedFetch(f: typeof fetch, timeoutMs: number): typeof fetch {
  return (input, init = {}) => f(input, { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
}

export function createClient(flags: GlobalFlags = {}, opts: ClientOptions = {}) {
  // Resolve the sources once so the config file is read at most once per client
  // and the base URL and the token can never disagree about the target host.
  const src = opts.sources ?? realSources();
  const base = resolveApi(flags, src);
  const token = resolveToken(flags, src);
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  const timed = timedFetch(opts.fetch ?? fetch, timeoutMs);
  // Retrying sits OUTSIDE the timeout, so every attempt gets a fresh deadline
  // instead of one shared by all the attempts and the waits between them.
  const doFetch = opts.retry ? retryingFetch(timed, opts.retry) : timed;
  const host = hostOf(base);

  async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json", ...(init.headers as Record<string, string> | undefined) };
    if (token) headers.authorization = `Bearer ${token}`;
    let res: Response;
    try {
      res = await doFetch(base + path, { ...init, headers });
    } catch (e) {
      throw asRegistryError(e, base, timeoutMs);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new RegistryError(`SkillMD API ${res.status} on ${path}: ${detail}`, res.status);
    }
    return (await res.json()) as T;
  }

  return { api, base, host, isDefaultHost: host === hostOf(DEFAULT_API), token, hasToken: Boolean(token), fetch: doFetch };
}

export type Client = ReturnType<typeof createClient>;

export interface BundleFile {
  path: string;
  contents: Buffer;
  /** The registry served this file as a URL but recorded no sha256 for it, so
   *  its bytes could only be checked against the transport (https + an
   *  allow-listed host), never against the registry's own record. */
  unverified?: boolean;
}

export interface BundleOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Retry a busy registry (and a busy source host) as retryingFetch does. */
  retry?: RetryOptions;
  /** Say why instead of answering null. An unavailable bundle, an unreadable
   *  response and a companion that could not be fetched all throw a
   *  RegistryError naming the cause, so a caller can refuse to install a pack
   *  without its files instead of quietly installing its SKILL.md alone.
   *  A companion the source repo answers 404 or 410 for is still "gone": it is
   *  reported through `missing` (when given) and the rest installs. */
  strict?: boolean;
  /** When given, a companion the registry only links to and the source repo
   *  no longer serves is skipped and its path pushed here, and the rest of the
   *  bundle still installs. Without it such a file fails the whole fetch, which
   *  is what an update wants: never replace a full install with a partial one. */
  missing?: string[];
}

/** Fetch a pack's full file set from the registry bundle.
 *
 *  Integrity, in two tiers, because "hash mismatch" and "no hash on record"
 *  are different events:
 *
 *  - A file whose bytes DISAGREE with a recorded sha256 aborts the whole
 *    install. That is tampering (or drift) and never degrades to a fetch.
 *  - Bytes the REGISTRY itself serves (inline base64) must carry a hash. The
 *    one exception is the generated SKILL.md, which is reconstructed per
 *    request and therefore has nothing stable to hash against.
 *  - A file delivered by URL from an allow-listed host with NO hash on record
 *    is fetched and flagged `unverified`. The registry records hashes only for
 *    companions whose bytes it hosts; the rest are links back to the source
 *    repo, and refusing them would make most packs uninstallable while adding
 *    no trust — those bytes come over https from the same repo the GitHub
 *    fallback path already reads. The caller surfaces the flag to the user.
 *
 *  Returns null if the bundle is unavailable, letting the caller fall back to
 *  GitHub. */
export async function fetchBundle(base: string, slug: string, token?: string, opts: BundleOptions = {}): Promise<BundleFile[] | null> {
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  const timed = timedFetch(opts.fetch ?? fetch, timeoutMs);
  const doFetch = opts.retry ? retryingFetch(timed, opts.retry) : timed;
  const strict = Boolean(opts.strict);
  const headers: Record<string, string> = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const path = `/api/skills/${slug}/bundle`;
  let res: Response | null;
  try {
    res = await doFetch(`${base}${path}?format=json`, { headers });
  } catch (e) {
    if (strict) throw asRegistryError(e, base, timeoutMs);
    res = null;
  }
  if (!res || !res.ok) {
    if (strict) throw new RegistryError(`SkillMD API ${res?.status} on ${path}`, res?.status);
    return null;
  }
  const data = (await res.json().catch(() => null)) as { files?: { path: string; content_base64?: string; source_url?: string; sha256?: string | null }[] } | null;
  if (!data?.files) {
    if (strict) throw new RegistryError(`unreadable bundle response on ${path}`, res.status);
    return null;
  }
  if (data.files.length > MAX_PACK_FILES) throw new Error(`pack too large: > ${MAX_PACK_FILES} files`);
  const out: BundleFile[] = [];
  let bytes = 0;
  for (const f of data.files) {
    let contents: Buffer;
    let fromUrl = false;
    if (f.content_base64 != null) {
      contents = Buffer.from(f.content_base64, "base64");
    } else if (f.source_url && isAllowedSourceUrl(f.source_url)) {
      let failure: unknown;
      const r = await doFetch(f.source_url).catch((e) => { failure = e; return null; });
      if (!r || !r.ok) {
        // Moved or deleted upstream. One such link used to fail the whole
        // bundle, and `add owner/name` then fell back to fetching the registry
        // slug as a GitHub repo, which does not exist: the install failed with
        // a misleading 404 instead of installing everything else.
        // Strictly, only an answer that says "gone" counts as gone: a busy host
        // or a dropped connection is a failure to name, not a file to skip.
        const gone = r !== null && (r.status === 404 || r.status === 410);
        if (opts.missing && (!strict || gone)) { opts.missing.push(f.path); continue; }
        if (strict) {
          const cause = failure ?? new RegistryError(`HTTP ${r?.status}`, r?.status);
          throw new RegistryError(`could not fetch ${f.path}: ${describeFailure(cause)}`, cause instanceof RegistryError ? cause.status : undefined, cause instanceof RegistryError ? cause.retryAfterSec : undefined);
        }
        throw new Error(`could not fetch companion file "${f.path}" from ${hostOf(f.source_url)}`);
      }
      contents = Buffer.from(await r.arrayBuffer());
      fromUrl = true;
    } else {
      continue; // unknown delivery / disallowed host: skip, never write
    }
    bytes += contents.length;
    if (bytes > MAX_PACK_BYTES) throw new Error(`pack too large: > ${Math.round(MAX_PACK_BYTES / (1024 * 1024))}MB`);
    if (f.sha256) {
      const got = createHash("sha256").update(contents).digest("hex");
      if (got !== f.sha256) throw new IntegrityError(`integrity check failed for "${f.path}" (expected ${f.sha256.slice(0, 12)}…, got ${got.slice(0, 12)}…)`);
    } else if (!fromUrl && f.path !== "SKILL.md") {
      // Bytes the registry served itself, with no hash to check them against
      // and no generated-file excuse: that is a broken record, not a link.
      throw new IntegrityError(`"${f.path}" has no sha256 in the registry bundle — refusing to install unverifiable content`);
    }
    out.push({ path: f.path, contents, ...(fromUrl && !f.sha256 ? { unverified: true } : {}) });
  }
  return out;
}

/** Companion files the registry links to but the source repo no longer serves. */
export function missingFilesNote(paths: string[]): string {
  const n = paths.length;
  const shown = paths.slice(0, 5).join(", ") + (n > 5 ? `, and ${n - 5} more` : "");
  const [f, was, it] = n === 1 ? ["file is", "was", "it"] : ["files are", "were", "them"];
  return `${n} companion ${f} gone from the source repo and ${was} not installed (${shown}); the skill may still refer to ${it}`;
}

// Mirrors the JSON returned by GET /api/skills/:owner/:name.
export interface RegistrySkill {
  slug: string;
  title: string;
  description: string;
  body_md?: string;
  raw_md?: string | null;
  license?: string | null;
  type?: "single" | "pack";
  verified?: boolean;
  source_repo?: string | null;
  commit_sha?: string | null;
  security_flags?: string[];
}
