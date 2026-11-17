import { describe, it, expect } from "vitest";
import { RegistryError } from "./api.js";
import { MAX_RETRY_WAIT_MS, createPacer, describeFailure, retryAfterMs, retryingFetch } from "./retry.js";

/** A scripted fetch: each call takes the next step. A step is a Response, an
 *  Error to reject with, or a function of the call. */
type Step = Response | Error;
function scripted(steps: Step[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)]!;
    if (step instanceof Error) throw step;
    // A Response body can be read once; hand out a fresh copy each time.
    return step.clone();
  }) as unknown as typeof fetch;
  return { f, calls };
}

const res = (status: number, headers: Record<string, string> = {}, body = "") => new Response(body, { status, headers });

function harness() {
  const waits: number[] = [];
  return {
    waits,
    opts: {
      sleep: async (ms: number) => { waits.push(ms); },
      jitter: () => 0,
      now: () => Date.parse("2026-11-17T10:00:00Z"),
    },
  };
}

describe("retryAfterMs", () => {
  const now = Date.parse("2026-11-17T10:00:00Z");
  it("reads delta-seconds", () => {
    expect(retryAfterMs("2", now)).toBe(2000);
    expect(retryAfterMs(" 37 ", now)).toBe(37_000);
    expect(retryAfterMs("0", now)).toBe(0);
  });
  it("reads an HTTP-date relative to the clock", () => {
    expect(retryAfterMs("Tue, 17 Nov 2026 10:00:05 GMT", now)).toBe(5000);
    expect(retryAfterMs("Tue, 17 Nov 2026 09:59:00 GMT", now)).toBe(0); // already past
  });
  it("answers null when there is nothing usable", () => {
    expect(retryAfterMs(null, now)).toBeNull();
    expect(retryAfterMs("soon", now)).toBeNull();
    expect(retryAfterMs("", now)).toBeNull();
  });
});

describe("retryingFetch", () => {
  it("passes a good response straight through, once", async () => {
    const { f, calls } = scripted([res(200, {}, "ok")]);
    const h = harness();
    const r = await retryingFetch(f, h.opts)("https://api.x/a");
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(h.waits).toEqual([]);
  });

  it("waits the Retry-After the server asked for, then tries again", async () => {
    const { f, calls } = scripted([res(429, { "retry-after": "2" }), res(200, {}, "ok")]);
    const h = harness();
    const r = await retryingFetch(f, h.opts)("https://api.x/a");
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(h.waits).toEqual([2000]);
  });

  it("understands the HTTP-date form of Retry-After", async () => {
    const { f } = scripted([res(503, { "retry-after": "Tue, 17 Nov 2026 10:00:03 GMT" }), res(200)]);
    const h = harness();
    await retryingFetch(f, h.opts)("https://api.x/a");
    expect(h.waits).toEqual([3000]);
  });

  it("backs off 1 s, 2 s, 4 s when the server names no wait", async () => {
    const { f, calls } = scripted([res(503), res(502), res(504), res(200)]);
    const h = harness();
    const r = await retryingFetch(f, h.opts)("https://api.x/a");
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(4); // 1 try + 3 retries
    expect(h.waits).toEqual([1000, 2000, 4000]);
  });

  it("stops after 4 attempts in total and fails a 5xx exactly as it fails a 429", async () => {
    const { f, calls } = scripted([res(503, {}, "down")]);
    const h = harness();
    const err = await retryingFetch(f, h.opts)("https://api.x/a").catch((e) => e);
    expect(calls).toHaveLength(4);
    expect(h.waits).toEqual([1000, 2000, 4000]);
    expect(err).toBeInstanceOf(RegistryError);
    expect(err.status).toBe(503);
    expect(err.retryAfterSec).toBeUndefined();
    expect(err.message).toBe("the SkillMD API is temporarily unavailable (HTTP 503), try again shortly");
  });

  // The API answers {"error":"temporarily_unavailable"} when D1 is busy. That
  // used to end a plugin install as a permanent SKILL.md-only copy of a pack.
  it("rides out a busy-D1 503 and returns the answer that follows", async () => {
    const busy = (headers: Record<string, string> = {}) => res(503, { "content-type": "application/json", ...headers }, JSON.stringify({ error: "temporarily_unavailable" }));
    const { f, calls } = scripted([busy(), busy({ "retry-after": "2" }), res(200, {}, "ok")]);
    const h = harness();
    const r = await retryingFetch(f, h.opts)("https://api.x/a");
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("ok");
    expect(calls).toHaveLength(3);
    expect(h.waits).toEqual([1000, 2000]); // no header: backoff; then the header's 2 s
  });

  it("fails a 429 that never lets up, naming the wait it asked for", async () => {
    const { f, calls } = scripted([res(429, { "retry-after": "1" })]);
    const h = harness();
    const err = await retryingFetch(f, h.opts)("https://api.x/a").catch((e) => e);
    expect(calls).toHaveLength(4);
    expect(err).toBeInstanceOf(RegistryError);
    expect(err.status).toBe(429);
    expect(err.retryAfterSec).toBe(1);
    expect(err.message).toBe("rate limited by the SkillMD API, try again in 1 s");
  });

  it("never waits longer than the cap: a bigger ask ends the retrying at once", async () => {
    const { f, calls } = scripted([res(429, { "retry-after": "37" }), res(200)]);
    const h = harness();
    const err = await retryingFetch(f, h.opts)("https://api.x/a").catch((e) => e);
    expect(calls).toHaveLength(1);
    expect(h.waits).toEqual([]);
    expect(err.status).toBe(429);
    expect(err.retryAfterSec).toBe(37);
    expect(err.message).toBe("rate limited by the SkillMD API, try again in 37 s");
  });

  it("waits exactly the cap when that is what the server asked for", async () => {
    expect(MAX_RETRY_WAIT_MS).toBe(10_000);
    const { f } = scripted([res(429, { "retry-after": "10" }), res(200)]);
    const h = harness();
    await retryingFetch(f, h.opts)("https://api.x/a");
    expect(h.waits).toEqual([10_000]);
  });

  it("also gives up on a 503 that asks for more than the cap", async () => {
    const { f, calls } = scripted([res(503, { "retry-after": "120" })]);
    const err = await retryingFetch(f, harness().opts)("https://api.x/a").catch((e) => e);
    expect(calls).toHaveLength(1);
    expect(err).toBeInstanceOf(RegistryError);
    expect(err.status).toBe(503);
    expect(err.message).toMatch(/try again in 120 s/);
  });

  it("never retries a 404, or any other answer that will not change", async () => {
    for (const status of [400, 401, 403, 404, 405, 410, 500]) {
      const { f, calls } = scripted([res(status)]);
      const h = harness();
      const r = await retryingFetch(f, h.opts)("https://api.x/a");
      expect(r.status).toBe(status);
      expect(calls).toHaveLength(1);
      expect(h.waits).toEqual([]);
    }
  });

  it("retries a network error and succeeds when the next try gets through", async () => {
    const { f, calls } = scripted([new TypeError("fetch failed"), new TypeError("fetch failed"), res(200)]);
    const h = harness();
    const r = await retryingFetch(f, h.opts)("https://api.x/a");
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(3);
    expect(h.waits).toEqual([1000, 2000]);
  });

  it("rethrows the network error once the attempts are spent", async () => {
    const boom = new TypeError("fetch failed");
    const { f, calls } = scripted([boom]);
    const h = harness();
    await expect(retryingFetch(f, h.opts)("https://api.x/a")).rejects.toBe(boom);
    expect(calls).toHaveLength(4);
    expect(h.waits).toEqual([1000, 2000, 4000]);
  });

  it("does not retry a request the caller itself cancelled", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const abort = new DOMException("The operation was aborted", "AbortError");
    const { f, calls } = scripted([abort]);
    const h = harness();
    await expect(retryingFetch(f, h.opts)("https://api.x/a", { signal: ctl.signal })).rejects.toBe(abort);
    expect(calls).toHaveLength(1);
  });

  it("sends the same request every time", async () => {
    const { f, calls } = scripted([res(503), res(200)]);
    await retryingFetch(f, harness().opts)("https://api.x/a", { headers: { accept: "application/json" } });
    expect(calls.map((c) => c.url)).toEqual(["https://api.x/a", "https://api.x/a"]);
    expect(calls[1]!.init?.headers).toEqual({ accept: "application/json" });
  });

  it("adds jitter to a wait but still never passes the cap", async () => {
    const a = scripted([res(503), res(200)]);
    const ha = harness();
    await retryingFetch(a.f, { ...ha.opts, jitter: () => 300 })("https://api.x/a");
    expect(ha.waits).toEqual([1300]);

    const b = scripted([res(429, { "retry-after": "10" }), res(200)]);
    const hb = harness();
    await retryingFetch(b.f, { ...hb.opts, jitter: () => 300 })("https://api.x/a");
    expect(hb.waits).toEqual([10_000]);
  });

  it("honours a different retry count", async () => {
    const { f, calls } = scripted([res(503)]);
    await retryingFetch(f, { ...harness().opts, retries: 1 })("https://api.x/a").catch(() => {});
    expect(calls).toHaveLength(2);
  });
});

describe("describeFailure", () => {
  it("says what a rate limit asked for", () => {
    expect(describeFailure(new RegistryError("x", 429, 2))).toBe("HTTP 429, retry in 2 s");
  });
  it("names the status of any other HTTP failure", () => {
    expect(describeFailure(new RegistryError("SkillMD API 404 on /x", 404))).toBe("HTTP 404");
  });
  it("keeps the message of a failure that was not an HTTP answer", () => {
    expect(describeFailure(new RegistryError("could not reach https://api.x: timed out"))).toBe("could not reach https://api.x: timed out");
    expect(describeFailure(new TypeError("fetch failed"))).toBe("fetch failed");
    expect(describeFailure("odd")).toBe("odd");
  });
});

describe("createPacer", () => {
  it("spaces requests at least `interval` apart however many callers there are", async () => {
    const slept: number[] = [];
    const pace = createPacer(250, {
      now: () => 1000, // frozen: every caller arrives in the same instant
      sleep: async (ms) => { slept.push(ms); },
    });
    await Promise.all([pace(), pace(), pace(), pace()]);
    // The first goes straight away; each later one is a full interval behind it.
    expect(slept).toEqual([250, 500, 750]);
  });

  it("does not make a caller wait when the interval has already passed", async () => {
    let clock = 0;
    const slept: number[] = [];
    const pace = createPacer(250, { now: () => clock, sleep: async (ms) => { slept.push(ms); clock += ms; } });
    await pace();
    clock += 1000;
    await pace();
    expect(slept).toEqual([]);
  });
});
