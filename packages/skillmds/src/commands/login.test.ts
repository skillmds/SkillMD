import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLogin, runLogout, cliUserAgent, abortableSleep } from "./login.js";
import type { LoginDeps } from "./login.js";
import { readConfig, writeConfig } from "../config.js";

const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "skillmd-login-")); tmps.push(d); return d; };
afterEach(() => { vi.restoreAllMocks(); for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });

// ---- A fake registry: everything below runs through an injected fetch, never the network.

const DEVICE_OK = {
  device_code: "DEVICE-CODE-SECRET-1234567890",
  user_code: "ABCD-EFGH",
  verification_uri: "https://skillmd.com/cli/authorize",
  verification_uri_complete: "https://skillmd.com/cli/authorize?code=ABCD-EFGH",
  expires_in: 600,
  interval: 5,
};
const TOKEN_OK = { access_token: "smd_" + "x".repeat(43), token_type: "Bearer", expires_in: 7776000 };

type Reply = { status?: number; body?: unknown } | Error | "hang";
interface Call { url: string; method: string; headers: Record<string, string>; body: unknown }

/** `token` is a queue of replies for POST /api/cli/token (the last one repeats). */
function fakeServer(opts: { device?: Reply; token?: Reply[]; revoke?: Reply } = {}) {
  const calls: Call[] = [];
  const queue = [...(opts.token ?? [{ status: 200, body: TOKEN_OK }])];
  const answer = (r: Reply): Promise<Response> => {
    if (r === "hang") return new Promise<Response>(() => {});
    if (r instanceof Error) return Promise.reject(r);
    return Promise.resolve(new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { "content-type": "application/json" } }));
  };
  const fetchFn = (async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ url, method, headers, body: typeof init.body === "string" ? JSON.parse(init.body) : init.body });
    if (url.endsWith("/api/cli/device") && method === "POST") return answer(opts.device ?? { status: 200, body: DEVICE_OK });
    if (url.endsWith("/api/cli/token") && method === "POST") return answer(queue.length > 1 ? queue.shift()! : queue[0]!);
    if (url.endsWith("/api/cli/token") && method === "DELETE") return answer(opts.revoke ?? { status: 200, body: { ok: true } });
    return answer({ status: 404, body: { error: "not_found" } });
  }) as typeof fetch;
  const of = (suffix: string, method?: string) => calls.filter((c) => c.url.endsWith(suffix) && (!method || c.method === method));
  return { fetch: fetchFn, calls, polls: () => of("/api/cli/token", "POST"), devices: () => of("/api/cli/device", "POST"), revokes: () => of("/api/cli/token", "DELETE") };
}

/** A fake clock: sleeping advances it, so a 10-minute poll takes no time. */
function fakeClock(start = 1_000_000) {
  let t = start;
  const sleeps: number[] = [];
  return { now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; }, sleeps, advance: (ms: number) => { t += ms; } };
}

/** Interactive deps over a fake server + clock; `lines` collects what is said. */
function interactive(server: ReturnType<typeof fakeServer>, extra: Partial<LoginDeps> = {}) {
  const clock = fakeClock();
  const lines: string[] = [];
  const opened: string[] = [];
  const deps: LoginDeps = {
    interactive: true,
    fetch: server.fetch,
    now: clock.now,
    sleep: clock.sleep,
    say: (l) => lines.push(l),
    openUrl: (u) => { opened.push(u); return true; },
    userAgent: "get-skill/9.9.9 (testos)",
    ...extra,
  };
  return { deps, clock, lines, opened };
}

describe("runLogin --token (unchanged)", () => {
  it("stores the token bound to the API host", async () => {
    const home = tmp();
    const r = await runLogin({ token: "sk_x", api: "https://staging.skillmd.com", home, env: {} }, {});
    expect(r.exitCode).toBe(0);
    expect(readConfig(home)).toMatchObject({ token: "sk_x", api: "https://staging.skillmd.com", tokenHost: "staging.skillmd.com" });
  });
  it("binds to SKILLMD_API when set and no --api is given", async () => {
    const home = tmp();
    await runLogin({ token: "sk_x", home, env: { SKILLMD_API: "https://alt.example" } }, {});
    expect(readConfig(home).tokenHost).toBe("alt.example");
  });
  it("prints the same line it always did", async () => {
    const home = tmp();
    const r = await runLogin({ token: "sk_x", home, env: {} }, {});
    expect(r.output).toBe(`Saved token for api.skillmd.com to ${join(home, ".skillmd", "config.json")}`);
  });
  it("never starts a browser login, even from a terminal", async () => {
    const server = fakeServer();
    const { deps, opened, lines } = interactive(server);
    const r = await runLogin({ token: "sk_x", home: tmp(), env: {} }, deps);
    expect(r.exitCode).toBe(0);
    expect(server.calls).toHaveLength(0);
    expect(opened).toHaveLength(0);
    expect(lines).toHaveLength(0);
  });
  it("refuses an http base at login time", async () => {
    const r = await runLogin({ token: "sk_x", api: "http://localhost:8787", home: tmp(), env: {} }, {});
    expect(r.exitCode).toBe(1);
    expect(r.output).toMatch(/https/);
  });
  it("--json returns a document", async () => {
    const home = tmp();
    const r = await runLogin({ token: "sk_x", home, env: {}, json: true }, {});
    expect(JSON.parse(r.output)).toMatchObject({ ok: true, host: "api.skillmd.com" });
  });
});

describe("runLogin off a terminal (no --token)", () => {
  it("exits 1 with the hint, naming --token, SKILLMD_TOKEN and that `skillmd login` works in a terminal", async () => {
    const server = fakeServer();
    const r = await runLogin({ home: tmp(), env: {} }, { fetch: server.fetch });
    expect(r.exitCode).toBe(1);
    expect(r.output).toMatch(/--token/);
    expect(r.output).toMatch(/SKILLMD_TOKEN/);
    expect(r.output).toMatch(/skillmd login/);
    expect(r.output).toMatch(/terminal/);
    expect(server.calls).toHaveLength(0); // no device code is requested nobody could approve
  });
  it("default deps honour an injected host-agent env — never starts a login, exits 1 with the hint", async () => {
    const home = tmp();
    const r = await runLogin({ home, env: { CLAUDECODE: "1" } });
    expect(r.exitCode).toBe(1);
    expect(r.output).toMatch(/--token|SKILLMD_TOKEN/);
  });
  it("--json keeps the hint a JSON document", async () => {
    const r = await runLogin({ home: tmp(), env: {}, json: true }, {});
    expect(r.exitCode).toBe(1);
    const doc = JSON.parse(r.output);
    expect(doc.ok).toBe(false);
    expect(doc.error).toMatch(/--token|SKILLMD_TOKEN/);
    expect(doc.error).toMatch(/skillmd login/);
  });
});

describe("runLogin browser login (device code)", () => {
  it("requests a code, prints it with the URL, opens the browser, polls, and stores the token bound to its host", async () => {
    const home = tmp();
    const server = fakeServer({ token: [{ status: 400, body: { error: "authorization_pending" } }, { status: 400, body: { error: "authorization_pending" } }, { status: 200, body: TOKEN_OK }] });
    const { deps, lines, opened, clock } = interactive(server);
    const r = await runLogin({ home, env: {} }, deps);

    expect(r.exitCode).toBe(0);
    expect(r.output).toBe(`Logged in. Saved token for api.skillmd.com to ${join(home, ".skillmd", "config.json")}`);
    expect(readConfig(home)).toMatchObject({ token: TOKEN_OK.access_token, tokenHost: "api.skillmd.com" });

    // The device request: POST, JSON, our User-Agent (the server shows it as the device label), no bearer.
    expect(server.devices()).toHaveLength(1);
    const dev = server.devices()[0]!;
    expect(dev.url).toBe("https://api.skillmd.com/api/cli/device");
    expect(dev.headers["user-agent"]).toBe("get-skill/9.9.9 (testos)");
    expect(dev.headers["content-type"]).toMatch(/json/);
    expect(dev.headers.authorization).toBeUndefined();

    // The person sees the URL and the code; the browser is opened on the complete URL.
    const said = lines.join("\n");
    expect(said).toContain("https://skillmd.com/cli/authorize?code=ABCD-EFGH");
    expect(said).toContain("ABCD-EFGH");
    expect(opened).toEqual(["https://skillmd.com/cli/authorize?code=ABCD-EFGH"]);

    // Polled three times, each one a POST of the device code, spaced by the server's interval.
    expect(server.polls()).toHaveLength(3);
    for (const p of server.polls()) {
      expect(p.url).toBe("https://api.skillmd.com/api/cli/token");
      expect(p.body).toEqual({ device_code: DEVICE_OK.device_code });
      expect(p.headers.authorization).toBeUndefined();
    }
    expect(clock.sleeps).toEqual([5000, 5000, 5000]);
  });

  it("never prints, opens or returns the device code (only its hash lives on the server; it is the secret)", async () => {
    const server = fakeServer();
    const { deps, lines, opened } = interactive(server);
    const r = await runLogin({ home: tmp(), env: {} }, deps);
    expect([...lines, ...opened, r.output].join("\n")).not.toContain(DEVICE_OK.device_code);
    expect(r.output).not.toContain(TOKEN_OK.access_token);
  });

  it("does not send an already-stored or SKILLMD_TOKEN bearer on the anonymous calls", async () => {
    const home = tmp();
    writeConfig({ token: "old_stored", tokenHost: "api.skillmd.com" }, home);
    const server = fakeServer();
    const { deps } = interactive(server);
    await runLogin({ home, env: { SKILLMD_TOKEN: "env_token" } }, deps);
    for (const c of server.calls) expect(c.headers.authorization).toBeUndefined();
    expect(readConfig(home).token).toBe(TOKEN_OK.access_token); // and the new token replaces the old one
  });

  it("honours the server's interval, and adds 5 s after slow_down", async () => {
    const server = fakeServer({
      device: { status: 200, body: { ...DEVICE_OK, interval: 7 } },
      token: [{ status: 400, body: { error: "slow_down" } }, { status: 400, body: { error: "authorization_pending" } }, { status: 200, body: TOKEN_OK }],
    });
    const { deps, clock } = interactive(server);
    const r = await runLogin({ home: tmp(), env: {} }, deps);
    expect(r.exitCode).toBe(0);
    expect(clock.sleeps).toEqual([7000, 12000, 12000]);
  });

  it("keeps polling on authorization_pending until the code expires, then stops at the expiry", async () => {
    const server = fakeServer({
      device: { status: 200, body: { ...DEVICE_OK, expires_in: 12, interval: 5 } },
      token: [{ status: 400, body: { error: "authorization_pending" } }],
    });
    const { deps, clock } = interactive(server);
    const home = tmp();
    const r = await runLogin({ home, env: {} }, deps);
    expect(r.exitCode).toBe(1);
    expect(r.output).toMatch(/expired/i);
    expect(r.output).not.toContain("\n");
    expect(server.polls().length).toBeLessThanOrEqual(3);
    // No sleep carries past the expiry.
    expect(clock.sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(12_000);
    expect(readConfig(home).token).toBeUndefined();
  });

  it("expired_token from the server ends with a clear one-line error, exit 1, nothing stored", async () => {
    const server = fakeServer({ token: [{ status: 400, body: { error: "expired_token" } }] });
    const { deps } = interactive(server);
    const home = tmp();
    const r = await runLogin({ home, env: {} }, deps);
    expect(r.exitCode).toBe(1);
    expect(r.output).toMatch(/expired/i);
    expect(r.output).toMatch(/skillmd login/);
    expect(r.output).not.toContain("\n");
    expect(readConfig(home).token).toBeUndefined();
  });

  it("access_denied ends with a clear one-line error, exit 1, nothing stored", async () => {
    const server = fakeServer({ token: [{ status: 400, body: { error: "access_denied" } }] });
    const { deps } = interactive(server);
    const home = tmp();
    const r = await runLogin({ home, env: {} }, deps);
    expect(r.exitCode).toBe(1);
    expect(r.output).toMatch(/denied/i);
    expect(r.output).not.toContain("\n");
    expect(readConfig(home).token).toBeUndefined();
  });

  it("an unknown error code from the server fails the login with that code", async () => {
    const server = fakeServer({ token: [{ status: 400, body: { error: "invalid_grant" } }] });
    const { deps } = interactive(server);
    const r = await runLogin({ home: tmp(), env: {} }, deps);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("invalid_grant");
  });

  it("tolerates a flaky network between polls, and gives up after repeated failures", async () => {
    const flaky = fakeServer({ token: [new Error("fetch failed"), { status: 503, body: {} }, { status: 200, body: TOKEN_OK }] });
    const a = interactive(flaky);
    expect((await runLogin({ home: tmp(), env: {} }, a.deps)).exitCode).toBe(0);
    expect(flaky.polls()).toHaveLength(3);

    const down = fakeServer({ token: [new Error("fetch failed")] });
    const b = interactive(down);
    const r = await runLogin({ home: tmp(), env: {} }, b.deps);
    expect(r.exitCode).toBe(1);
    expect(r.output).toMatch(/could not reach/i);
    expect(down.polls().length).toBeLessThanOrEqual(6);
  });

  it("treats a 429 on the poll as slow_down", async () => {
    const server = fakeServer({ token: [{ status: 429, body: {} }, { status: 200, body: TOKEN_OK }] });
    const { deps, clock } = interactive(server);
    expect((await runLogin({ home: tmp(), env: {} }, deps)).exitCode).toBe(0);
    expect(clock.sleeps).toEqual([5000, 10000]);
  });

  it("rejects a success reply whose token is not a plain header-safe string, and stores nothing", async () => {
    for (const bad of [undefined, "", "has space", "line\nbreak", "smd_\u0000nul"]) {
      const server = fakeServer({ token: [{ status: 200, body: { access_token: bad, token_type: "Bearer" } }] });
      const { deps } = interactive(server);
      const home = tmp();
      const r = await runLogin({ home, env: {} }, deps);
      expect(r.exitCode).toBe(1);
      expect(readConfig(home).token).toBeUndefined();
    }
  });

  it("falls back to verification_uri when there is no complete URL", async () => {
    const { verification_uri_complete: _drop, ...noComplete } = DEVICE_OK;
    const server = fakeServer({ device: { status: 200, body: noComplete } });
    const { deps, lines, opened } = interactive(server);
    expect((await runLogin({ home: tmp(), env: {} }, deps)).exitCode).toBe(0);
    expect(opened).toEqual(["https://skillmd.com/cli/authorize"]);
    expect(lines.join("\n")).toContain("ABCD-EFGH");
  });

  it("a failing opener never fails the login (the URL was printed)", async () => {
    const server = fakeServer();
    const { deps, lines } = interactive(server, { openUrl: () => { throw new Error("no browser"); } });
    const r = await runLogin({ home: tmp(), env: {} }, deps);
    expect(r.exitCode).toBe(0);
    expect(lines.join("\n")).toContain("https://skillmd.com/cli/authorize?code=ABCD-EFGH");
  });

  it("strips terminal escapes out of what the server asks us to print", async () => {
    const server = fakeServer({ device: { status: 200, body: { ...DEVICE_OK, user_code: "AB\u001b[2JCD-EFGH" } } });
    const { deps, lines } = interactive(server);
    await runLogin({ home: tmp(), env: {} }, deps);
    // Our own colouring (SGR) is fine; the server's cursor-control sequence is not.
    const shown = lines.join("\n").replace(/\u001b\[[0-9;]*m/g, "");
    expect(shown).not.toContain("\u001b");
    expect(shown).toContain("ABCD-EFGH");
  });

  it("binds to --api: the requests go there and the token is stored for that host", async () => {
    const home = tmp();
    const server = fakeServer();
    const { deps } = interactive(server);
    const r = await runLogin({ api: "https://staging.skillmd.com", home, env: {} }, deps);
    expect(r.exitCode).toBe(0);
    expect(server.devices()[0]!.url).toBe("https://staging.skillmd.com/api/cli/device");
    expect(server.polls()[0]!.url).toBe("https://staging.skillmd.com/api/cli/token");
    expect(readConfig(home)).toMatchObject({ api: "https://staging.skillmd.com", tokenHost: "staging.skillmd.com" });
  });

  it("refuses an http API base before sending anything; --insecure-http allows it (local development)", async () => {
    const refused = fakeServer();
    const a = interactive(refused);
    const r = await runLogin({ api: "http://127.0.0.1:8787", home: tmp(), env: {} }, a.deps);
    expect(r.exitCode).toBe(1);
    expect(r.output).toMatch(/https/);
    expect(refused.calls).toHaveLength(0);

    const home = tmp();
    const dev = fakeServer({ device: { status: 200, body: { ...DEVICE_OK, verification_uri_complete: "http://127.0.0.1:8787/cli/authorize?code=ABCD-EFGH" } } });
    const b = interactive(dev);
    const ok = await runLogin({ api: "http://127.0.0.1:8787", insecureHttp: true, home, env: {} }, b.deps);
    expect(ok.exitCode).toBe(0);
    expect(readConfig(home).tokenHost).toBe("127.0.0.1:8787");
    expect(b.opened).toEqual(["http://127.0.0.1:8787/cli/authorize?code=ABCD-EFGH"]);
  });

  it("will not print or open an address that is not https (or http on an http dev base)", async () => {
    for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "http://skillmd.com/cli/authorize?code=ABCD-EFGH", "not a url"]) {
      const server = fakeServer({ device: { status: 200, body: { ...DEVICE_OK, verification_uri: bad, verification_uri_complete: bad } } });
      const { deps, lines, opened } = interactive(server);
      const r = await runLogin({ home: tmp(), env: {} }, deps);
      expect(r.exitCode).toBe(1);
      expect(opened).toHaveLength(0);
      expect(server.polls()).toHaveLength(0);
      expect(lines.join("\n")).not.toContain(bad);
    }
  });

  describe("when the device request fails", () => {
    it("404 or 405: this registry has no browser login, so say how to use --token", async () => {
      for (const status of [404, 405]) {
        const { deps } = interactive(fakeServer({ device: { status, body: {} } }));
        const r = await runLogin({ home: tmp(), env: {} }, deps);
        expect(r.exitCode).toBe(1);
        expect(r.output).toMatch(/--token/);
        expect(r.output).toMatch(/SKILLMD_TOKEN/);
      }
    });
    it("429: rate limited", async () => {
      const { deps } = interactive(fakeServer({ device: { status: 429, body: { error: "rate_limited" } } }));
      const r = await runLogin({ home: tmp(), env: {} }, deps);
      expect(r.exitCode).toBe(1);
      expect(r.output).toMatch(/too many|try again/i);
    });
    it("network failure: could not reach", async () => {
      const { deps } = interactive(fakeServer({ device: new Error("fetch failed") }));
      const r = await runLogin({ home: tmp(), env: {} }, deps);
      expect(r.exitCode).toBe(1);
      expect(r.output).toMatch(/could not reach/i);
    });
    it("a reply with no device_code or user_code is an error, not a hang", async () => {
      for (const body of [{}, { ...DEVICE_OK, device_code: "" }, { ...DEVICE_OK, user_code: undefined }, "nope"]) {
        const { deps } = interactive(fakeServer({ device: { status: 200, body } }));
        const r = await runLogin({ home: tmp(), env: {} }, deps);
        expect(r.exitCode).toBe(1);
        expect(r.output).toMatch(/unexpected/i);
      }
    });
  });

  describe("cancelling", () => {
    it("Ctrl-C while waiting exits 0 with Cancelled., stores nothing", async () => {
      const ac = new AbortController();
      const server = fakeServer({ token: [{ status: 400, body: { error: "authorization_pending" } }] });
      const clock = fakeClock();
      const home = tmp();
      const r = await runLogin({ home, env: {} }, {
        interactive: true, fetch: server.fetch, now: clock.now, say: () => {}, openUrl: () => true, signal: ac.signal,
        sleep: async (ms) => { clock.sleeps.push(ms); ac.abort(); },
      });
      expect(r.exitCode).toBe(0);
      expect(r.output).toContain("Cancelled.");
      expect(readConfig(home).token).toBeUndefined();
      expect(server.polls()).toHaveLength(0); // it did not poll after being cancelled
    });
    it("Ctrl-C while a request is in flight does not wait for it", async () => {
      const ac = new AbortController();
      const server = fakeServer({ token: ["hang"] });
      const clock = fakeClock();
      setTimeout(() => ac.abort(), 20);
      const r = await runLogin({ home: tmp(), env: {} }, {
        interactive: true, fetch: server.fetch, now: clock.now, sleep: clock.sleep, say: () => {}, openUrl: () => true, signal: ac.signal,
      });
      expect(r.exitCode).toBe(0);
      expect(r.output).toContain("Cancelled.");
    });
    it("cancelled before the first request: nothing is requested", async () => {
      const ac = new AbortController();
      ac.abort();
      const server = fakeServer();
      const { deps } = interactive(server, { signal: ac.signal });
      const r = await runLogin({ home: tmp(), env: {} }, deps);
      expect(r.exitCode).toBe(0);
      expect(r.output).toContain("Cancelled.");
      expect(server.calls).toHaveLength(0);
    });
    it("--json keeps a cancellation a JSON document", async () => {
      const ac = new AbortController();
      const server = fakeServer();
      const clock = fakeClock();
      const r = await runLogin({ home: tmp(), env: {}, json: true }, {
        interactive: true, fetch: server.fetch, now: clock.now, say: () => {}, openUrl: () => true, signal: ac.signal,
        sleep: async () => { ac.abort(); },
      });
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.output)).toMatchObject({ ok: false, cancelled: true });
    });
  });

  describe("--json", () => {
    it("the result is one JSON document; the code and URL go to the say sink, never into it", async () => {
      const home = tmp();
      const server = fakeServer();
      const { deps, lines } = interactive(server);
      const r = await runLogin({ home, env: {}, json: true }, deps);
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.output)).toEqual({ ok: true, file: join(home, ".skillmd", "config.json"), host: "api.skillmd.com" });
      expect(r.output).not.toContain("ABCD-EFGH");
      expect(lines.join("\n")).toContain("ABCD-EFGH");
    });
    it("without an injected sink the lines go to stderr, and stdout stays untouched", async () => {
      const out = vi.spyOn(console, "log").mockImplementation(() => {});
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const server = fakeServer();
      const { deps } = interactive(server, { say: undefined });
      await runLogin({ home: tmp(), env: {}, json: true }, deps);
      expect(out).not.toHaveBeenCalled();
      expect(err.mock.calls.flat().join("\n")).toContain("ABCD-EFGH");
    });
    it("without --json the lines go to stdout", async () => {
      const out = vi.spyOn(console, "log").mockImplementation(() => {});
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const server = fakeServer();
      const { deps } = interactive(server, { say: undefined });
      await runLogin({ home: tmp(), env: {} }, deps);
      expect(out.mock.calls.flat().join("\n")).toContain("ABCD-EFGH");
      expect(err).not.toHaveBeenCalled();
    });
    it("failures are a document too: expired, denied, request failed", async () => {
      for (const token of [{ status: 400, body: { error: "expired_token" } }, { status: 400, body: { error: "access_denied" } }]) {
        const { deps } = interactive(fakeServer({ token: [token] }));
        const r = await runLogin({ home: tmp(), env: {}, json: true }, deps);
        expect(r.exitCode).toBe(1);
        const doc = JSON.parse(r.output);
        expect(doc.ok).toBe(false);
        expect(typeof doc.error).toBe("string");
      }
      const { deps } = interactive(fakeServer({ device: { status: 429, body: {} } }));
      const r = await runLogin({ home: tmp(), env: {}, json: true }, deps);
      expect(JSON.parse(r.output)).toMatchObject({ ok: false });
    });
  });
});

describe("cliUserAgent", () => {
  it("is get-skill/<version> (<platform>)", () => {
    expect(cliUserAgent("1.2.3", "linux")).toBe("get-skill/1.2.3 (linux)");
  });
  it("defaults to this package's real version", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
    expect(cliUserAgent()).toBe(`get-skill/${pkg.version} (${process.platform})`);
  });
});

describe("abortableSleep", () => {
  it("resolves after the delay", async () => {
    const t0 = Date.now();
    await abortableSleep(30);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
  });
  it("resolves early when aborted, and at once when already aborted", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 10);
    const t0 = Date.now();
    await abortableSleep(5000, ac.signal);
    expect(Date.now() - t0).toBeLessThan(1000);
    await abortableSleep(5000, ac.signal);
  });
});

describe("runLogout", () => {
  const stored = (home: string, extra: Record<string, unknown> = {}) =>
    writeConfig({ token: "smd_stored", tokenHost: "api.skillmd.com", ...extra }, home);

  it("revokes the stored token on its own host with that bearer, then removes it", async () => {
    const home = tmp();
    stored(home);
    const server = fakeServer();
    const r = await runLogout({ home, env: {} }, { fetch: server.fetch });
    expect(r.exitCode).toBe(0);
    expect(r.output).toBe("Revoked and removed stored token.");
    expect(server.revokes()).toHaveLength(1);
    expect(server.revokes()[0]!.url).toBe("https://api.skillmd.com/api/cli/token");
    expect(server.revokes()[0]!.headers.authorization).toBe("Bearer smd_stored");
    expect(readConfig(home).token).toBeUndefined();
    expect(readConfig(home).tokenHost).toBeUndefined();
  });
  it("--json: one document, with revoked", async () => {
    const home = tmp();
    stored(home);
    const r = await runLogout({ home, env: {}, json: true }, { fetch: fakeServer().fetch });
    expect(JSON.parse(r.output)).toEqual({ ok: true, removed: true, revoked: true });
  });
  it("a refusing server (401, 403, 500) never fails the logout: the token is still removed", async () => {
    for (const status of [401, 403, 500]) {
      const home = tmp();
      stored(home);
      const r = await runLogout({ home, env: {} }, { fetch: fakeServer({ revoke: { status, body: {} } }).fetch });
      expect(r.exitCode).toBe(0);
      expect(r.output).toBe("Removed stored token.");
      expect(readConfig(home).token).toBeUndefined();
    }
  });
  it("a network failure never fails the logout", async () => {
    const home = tmp();
    stored(home);
    const r = await runLogout({ home, env: {}, json: true }, { fetch: fakeServer({ revoke: new Error("fetch failed") }).fetch });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.output)).toEqual({ ok: true, removed: true, revoked: false });
    expect(readConfig(home).token).toBeUndefined();
  });
  it("a server that never answers is cut off by the timeout (3 s by default) and the token is still removed", async () => {
    const home = tmp();
    stored(home);
    const seen: (AbortSignal | null | undefined)[] = [];
    const hang = ((_u: unknown, init: RequestInit = {}) => {
      seen.push(init.signal);
      return new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    }) as typeof fetch;
    const r = await runLogout({ home, env: {} }, { fetch: hang, timeoutMs: 25 });
    expect(r.exitCode).toBe(0);
    expect(seen[0]).toBeInstanceOf(AbortSignal);
    expect(readConfig(home).token).toBeUndefined();
  });
  it("sends only to the token's own host, and only the stored token (not SKILLMD_TOKEN)", async () => {
    const home = tmp();
    stored(home, { tokenHost: "staging.skillmd.com", api: "https://staging.skillmd.com" });
    const server = fakeServer();
    // The environment points elsewhere and carries its own token.
    await runLogout({ home, env: { SKILLMD_API: "https://other.example", SKILLMD_TOKEN: "env_token" } }, { fetch: server.fetch });
    expect(server.calls).toHaveLength(1);
    expect(new URL(server.calls[0]!.url).host).toBe("staging.skillmd.com");
    expect(server.calls[0]!.headers.authorization).toBe("Bearer smd_stored");
  });
  it("an --api that is not the token's host is not sent the token", async () => {
    const home = tmp();
    stored(home);
    const server = fakeServer();
    await runLogout({ home, env: {}, api: "https://evil.example" }, { fetch: server.fetch });
    for (const c of server.calls) expect(new URL(c.url).host).toBe("api.skillmd.com");
  });
  it("never uses http:// for the token unless --insecure-http", async () => {
    const home = tmp();
    stored(home, { tokenHost: "127.0.0.1:8787", api: "http://127.0.0.1:8787" });
    const refused = fakeServer();
    const r = await runLogout({ home, env: {} }, { fetch: refused.fetch });
    expect(refused.calls).toHaveLength(0); // an http base is refused, not guessed at
    expect(r.exitCode).toBe(0);
    expect(readConfig(home).token).toBeUndefined();

    stored(home, { tokenHost: "127.0.0.1:8787", api: "http://127.0.0.1:8787" });
    const allowed = fakeServer();
    await runLogout({ home, env: {}, insecureHttp: true }, { fetch: allowed.fetch });
    expect(allowed.revokes()[0]!.url).toBe("http://127.0.0.1:8787/api/cli/token");
  });
  it("a pre-1.2 config (no tokenHost) is bound to the default host", async () => {
    const home = tmp();
    writeConfig({ token: "smd_old" }, home);
    const server = fakeServer();
    await runLogout({ home, env: {} }, { fetch: server.fetch });
    expect(server.revokes()[0]!.url).toBe("https://api.skillmd.com/api/cli/token");
  });
  it("exit 0 and no request when nothing was stored (also with only SKILLMD_TOKEN set)", async () => {
    const home = tmp();
    const server = fakeServer();
    const r = await runLogout({ home, env: { SKILLMD_TOKEN: "env_token" } }, { fetch: server.fetch });
    expect(r.exitCode).toBe(0);
    expect(r.output).toBe("No stored token.");
    expect(server.calls).toHaveLength(0);
    expect((await runLogout({ home, env: {}, json: true }, { fetch: server.fetch })).output).toContain('"removed": false');
  });
});
