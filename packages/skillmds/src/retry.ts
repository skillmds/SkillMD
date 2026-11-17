// A fetch that rides out a busy registry.
//
// The API has a per-IP ceiling of a few requests a second and answers over it
// with a 429 and a Retry-After. A plugin install used to treat that as final.
// This waits the time the server asked for, a few times, and when the server
// asks for longer than is worth waiting it says so instead of hanging.
import { RegistryError } from "./errors.js";

/** Statuses that mean "try again": rate limited, or the registry/edge hiccuped. */
const RETRY_STATUSES = new Set([429, 502, 503, 504]);

/** The longest a single wait may be. A server asking for more ends the retrying. */
export const MAX_RETRY_WAIT_MS = 10_000;
/** Retries after the first attempt, so 4 attempts in total. */
export const MAX_RETRIES = 3;
/** Backoff when the server names no wait: 1 s, 2 s, 4 s. */
const BACKOFF_MS = 1000;
/** Spread simultaneous retriers so they do not all wake on the same millisecond. */
const JITTER_MS = 250;

export type Sleep = (ms: number) => Promise<void>;

export interface RetryOptions {
  /** Retries after the first attempt. Default 3. */
  retries?: number;
  /** The longest single wait. Default 10 s. */
  maxWaitMs?: number;
  /** Injected in tests so nothing really waits. */
  sleep?: Sleep;
  /** The clock, for an HTTP-date Retry-After. */
  now?: () => number;
  /** Extra milliseconds added to each wait. Default: a random 0–250. */
  jitter?: () => number;
}

export const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A Retry-After header as milliseconds: delta-seconds or an HTTP-date. */
export function retryAfterMs(header: string | null | undefined, now: number): number | null {
  const v = header?.trim();
  if (!v) return null;
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

function throttled(status: number, askedMs: number | null): RegistryError {
  const sec = askedMs === null ? undefined : Math.ceil(askedMs / 1000);
  const when = sec === undefined ? "shortly" : `in ${sec} s`;
  const message = status === 429
    ? `rate limited by the SkillMD API, try again ${when}`
    : `the SkillMD API is temporarily unavailable (HTTP ${status}), try again ${when}`;
  return new RegistryError(message, status, sec);
}

/** Don't leave a response we are discarding holding its connection open.
 *  Not awaited: cancelling a stream can wait on its other readers, and a
 *  retry has no reason to wait for the old answer to finish closing. */
function discard(res: Response): void {
  try { void res.body?.cancel().catch(() => {}); } catch { /* already consumed or closed */ }
}

/**
 * `inner`, retried. A response that is not worth retrying (any 2xx, a 404, a
 * 500 …) is returned as it is. On 429/502/503/504 and on network errors it
 * waits and tries again, up to `retries` more times; the wait is the server's
 * Retry-After, else 1 s, 2 s, 4 s, and never more than the cap.
 *
 * A 503 (the API's "temporarily_unavailable", D1 busy) is a 429 in every way
 * that matters here. When it gives up, because the retries ran out or because
 * the server asked for longer than the cap, it throws a RegistryError that
 * carries the status and the wait the server asked for ("rate limited …, try
 * again in 37 s"). A network error is rethrown as it was. A request the caller
 * cancelled itself is never retried.
 */
export function retryingFetch(inner: typeof fetch, opts: RetryOptions = {}): typeof fetch {
  const retries = opts.retries ?? MAX_RETRIES;
  const cap = opts.maxWaitMs ?? MAX_RETRY_WAIT_MS;
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? Date.now;
  const jitter = opts.jitter ?? (() => Math.random() * JITTER_MS);
  const wait = (ms: number) => sleep(Math.min(cap, ms + jitter()));

  return async (input, init) => {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await inner(input, init);
      } catch (e) {
        if (attempt >= retries || init?.signal?.aborted) throw e;
        await wait(BACKOFF_MS * 2 ** attempt);
        continue;
      }
      if (!RETRY_STATUSES.has(res.status)) return res;

      const asked = retryAfterMs(res.headers.get("retry-after"), now());
      if ((asked !== null && asked > cap) || attempt >= retries) {
        discard(res);
        throw throttled(res.status, asked);
      }
      discard(res);
      await wait(asked ?? BACKOFF_MS * 2 ** attempt);
    }
  };
}

/** Why a request failed, in a few words for a one-line report:
 *  "HTTP 429, retry in 2 s", "HTTP 404", or the failure's own message. */
export function describeFailure(e: unknown): string {
  if (e instanceof RegistryError && e.status !== undefined) {
    return `HTTP ${e.status}${e.retryAfterSec !== undefined ? `, retry in ${e.retryAfterSec} s` : ""}`;
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * One slot every `intervalMs`, however many callers ask. A caller awaits
 * `pace()` before each request; slots are claimed synchronously, so concurrent
 * workers queue behind one another instead of bursting together.
 */
export function createPacer(
  intervalMs: number,
  clock: { now?: () => number; sleep?: Sleep } = {},
): () => Promise<void> {
  const now = clock.now ?? Date.now;
  const sleep = clock.sleep ?? realSleep;
  let next = 0;
  return async () => {
    const t = now();
    const at = Math.max(t, next);
    next = at + intervalMs;
    if (at > t) await sleep(at - t);
  };
}
