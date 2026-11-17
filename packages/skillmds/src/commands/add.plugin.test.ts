// `add plugin:owner/slug`, end to end against a fake registry: the requests it
// makes, what lands on disk, and what it says when the registry is busy.
//
// Nothing here touches the network. Every request goes through an injected
// fetch and every wait through an injected sleeper, and telemetry is off, so no
// install ping is sent either.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { makeDefaultDeps, runAdd } from "./add.js";
import type { AddFlags } from "./add.js";
import { stripAnsi } from "../ui.js";

// A machine with Claude Code must not turn these into a managed plugin install.
vi.mock("../claudePlugin.js", async (orig) => ({
  ...(await orig<typeof import("../claudePlugin.js")>()),
  claudeCliAvailable: async () => false,
  installPluginNatively: async () => ({ ok: false, reason: "no Claude Code directory on this machine" }),
}));

const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "skillmd-plugin-")); tmps.push(d); return d; };
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });

const BASE = "https://api.test";
const sha = (s: string) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
const skillMd = (name: string) => `---\nname: ${name}\ndescription: A complete skill that explains how to do the ${name} thing and when to reach for it.\nlicense: MIT\n---\n# ${name}\n\n${"Plenty of detailed body content well past two hundred characters in total. ".repeat(3)}\n`;

interface FileSpec { path: string; body: string; inZip?: boolean; sha?: "good" | "none" | "wrong" }
interface MemberSpec { name: string; type?: "single" | "pack"; files?: FileSpec[] }

const slugOf = (m: MemberSpec) => `o/${m.name}`;
const fileUrl = (m: MemberSpec, f: FileSpec) => `https://api.skillmd.com/api/skills/${slugOf(m)}/files/${f.path}`;

function manifestFor(members: MemberSpec[]) {
  return {
    format: 1, slug: "o/p", name: "Test Plugin", download: `${BASE}/api/packs/o/p/download`,
    members: members.map((m) => ({
      slug: slugOf(m), dir: m.name, type: m.type ?? (m.files?.length ? "pack" : "single"), verified: false,
      files: (m.files ?? []).map((f) => ({
        path: f.path, size_bytes: f.body.length, storage: "r2", url: fileUrl(m, f),
        sha256: f.sha === "none" ? null : f.sha === "wrong" ? sha("something else") : sha(f.body),
      })),
    })),
  };
}

function zipFor(members: MemberSpec[], skip: string[] = []) {
  const entries: Record<string, Uint8Array> = {};
  for (const m of members) {
    if (skip.includes(m.name)) continue;
    entries[`${m.name}/SKILL.md`] = strToU8(skillMd(m.name));
    for (const f of m.files ?? []) if (f.inZip !== false) entries[`${m.name}/${f.path}`] = strToU8(f.body);
  }
  return zipSync(entries);
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

type Req = { method: string; path: string; url: string };
/** A fetch that logs every request and answers from `route` (a 404 when it does not). */
function fakeFetch(route: (r: Req) => Response | undefined | Promise<Response | undefined>) {
  const log: Req[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const u = new URL(url);
    const r = { method: init?.method ?? "GET", path: u.pathname + u.search, url };
    log.push(r);
    return (await route(r)) ?? new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { f, log };
}

/** A clock the sleeper drives, so pacing and backoff are visible and instant. */
function clock() {
  let t = 1_000_000;
  const waits: number[] = [];
  return {
    waits,
    now: () => t,
    sleep: async (ms: number) => { waits.push(ms); t += ms; },
    opts: { jitter: () => 0 },
  };
}

function flagsFor(extra: Partial<AddFlags> = {}): AddFlags {
  const home = tmp();
  return { cwd: home, home, global: true, yes: true, agent: ["cursor"], api: BASE, env: { SKILLMD_NO_TELEMETRY: "1" }, ...extra };
}

function depsFor(flags: AddFlags, f: typeof fetch, c = clock()) {
  return makeDefaultDeps(flags, {
    fetch: f,
    sources: { env: {}, config: {} },
    retry: { sleep: c.sleep, now: c.now, ...c.opts },
  });
}

const installed = (flags: AddFlags, name: string, rel = "SKILL.md") => join(flags.home!, ".cursor", "skills", name, rel);

describe("plugin install through the manifest", () => {
  const members39: MemberSpec[] = Array.from({ length: 39 }, (_, i) => ({
    name: `skill-${String(i).padStart(2, "0")}`,
    files: i % 3 === 0 ? [{ path: "agents/openai.yaml", body: `agent ${i}` }, { path: "references/notes.md", body: `notes ${i}` }] : [],
  }));

  it("makes exactly two requests for a 39-member plugin and installs every member with its companions", async () => {
    const zip = zipFor(members39);
    const { f, log } = fakeFetch((r) => {
      if (r.path === "/api/packs/o/p/manifest") return json(manifestFor(members39));
      if (r.path === "/api/packs/o/p/download") return new Response(zip, { status: 200 });
    });
    const flags = flagsFor();
    const run = await runAdd("plugin:o/p", flags, depsFor(flags, f));
    expect(log.map((r) => r.path).sort()).toEqual(["/api/packs/o/p/download", "/api/packs/o/p/manifest"]);
    expect(run.exitCode).toBe(0);
    expect(run.blocked).toEqual([]);
    expect(run.written).toHaveLength(39);
    expect(readFileSync(installed(flags, "skill-00", "agents/openai.yaml"), "utf8")).toBe("agent 0");
    expect(readFileSync(installed(flags, "skill-36", "references/notes.md"), "utf8")).toBe("notes 36");
    expect(existsSync(installed(flags, "skill-01", "SKILL.md"))).toBe(true);
    expect(existsSync(installed(flags, "skill-01", "agents"))).toBe(false); // none listed, none invented
  });

  it("never asks for the member list or a bundle on this path", async () => {
    const { f, log } = fakeFetch((r) => {
      if (r.path.endsWith("/manifest")) return json(manifestFor(members39.slice(0, 3)));
      if (r.path.endsWith("/download")) return new Response(zipFor(members39.slice(0, 3)), { status: 200 });
    });
    const flags = flagsFor();
    await runAdd("plugin:o/p", flags, depsFor(flags, f));
    expect(log.some((r) => r.path.includes("/bundle") || r.path.startsWith("/api/packs/o/p?"))).toBe(false);
  });

  it("asks for the manifest and the archive at the same time", async () => {
    const started: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const members = members39.slice(0, 2);
    const { f } = fakeFetch(async (r) => {
      started.push(r.path);
      if (started.length < 2) await gate; // the first waits for the second to be sent
      else release();
      if (r.path.endsWith("/manifest")) return json(manifestFor(members));
      if (r.path.endsWith("/download")) return new Response(zipFor(members), { status: 200 });
    });
    const flags = flagsFor();
    const run = await runAdd("plugin:o/p", flags, depsFor(flags, f));
    expect(run.exitCode).toBe(0);
    expect(started).toHaveLength(2);
  });

  it("reports members the archive does not hold and installs the rest", async () => {
    const members: MemberSpec[] = [{ name: "alpha" }, { name: "beta" }, { name: "gamma" }];
    const { f } = fakeFetch((r) => {
      if (r.path.endsWith("/manifest")) return json(manifestFor(members));
      if (r.path.endsWith("/download")) return new Response(zipFor(members, ["beta"]), { status: 200 });
    });
    const flags = flagsFor();
    const run = await runAdd("plugin:o/p", flags, depsFor(flags, f));
    expect(run.written.map((w) => w.name).sort()).toEqual(["alpha", "gamma"]);
    expect(run.exitCode).toBe(0);
    expect(stripAnsi(run.output)).toMatch(/o\/beta/);
  });

  it("blocks only the member whose companion fails its checksum", async () => {
    const members: MemberSpec[] = [
      { name: "alpha", files: [{ path: "a.md", body: "A" }] },
      { name: "bad", files: [{ path: "b.md", body: "B", sha: "wrong" }] },
      { name: "gamma", files: [{ path: "g.md", body: "G" }] },
    ];
    const { f } = fakeFetch((r) => {
      if (r.path.endsWith("/manifest")) return json(manifestFor(members));
      if (r.path.endsWith("/download")) return new Response(zipFor(members), { status: 200 });
    });
    const flags = flagsFor();
    const run = await runAdd("plugin:o/p", flags, depsFor(flags, f));
    expect(run.exitCode).toBe(1);
    expect(run.blocked).toHaveLength(1);
    expect(run.blocked[0]!.name).toBe("bad");
    expect(run.blocked[0]!.reason).toMatch(/integrity check failed for "b\.md"/);
    expect(existsSync(installed(flags, "bad"))).toBe(false);
    expect(existsSync(installed(flags, "alpha", "a.md"))).toBe(true);
    expect(existsSync(installed(flags, "gamma", "g.md"))).toBe(true);
  });

  describe("a companion the archive does not hold", () => {
    const members: MemberSpec[] = [
      { name: "alpha", files: [{ path: "agents/openai.yaml", body: "OPENAI", inZip: false }, { path: "a.md", body: "A" }] },
      { name: "beta" },
    ];

    it("is fetched from its own url, riding out a 429", async () => {
      let tries = 0;
      const { f, log } = fakeFetch((r) => {
        if (r.path.endsWith("/manifest")) return json(manifestFor(members));
        if (r.path.endsWith("/download")) return new Response(zipFor(members), { status: 200 });
        // The manifest names the registry's public address; the install reads the one it was pointed at.
        if (r.path === "/api/skills/o/alpha/files/agents/openai.yaml") {
          return tries++ === 0 ? new Response("", { status: 429, headers: { "retry-after": "2" } }) : new Response("OPENAI", { status: 200 });
        }
      });
      const flags = flagsFor();
      const c = clock();
      const run = await runAdd("plugin:o/p", flags, depsFor(flags, f, c));
      expect(run.exitCode).toBe(0);
      expect(readFileSync(installed(flags, "alpha", "agents/openai.yaml"), "utf8")).toBe("OPENAI");
      expect(c.waits).toEqual([2000]);
      expect(log.filter((r) => r.path.includes("/files/"))).toHaveLength(2); // the 429 and the retry
      expect(log.every((r) => r.url.startsWith(BASE))).toBe(true); // never the production host the manifest named
    });

    it("blocks that member alone, with the reason, when it never arrives", async () => {
      const { f } = fakeFetch((r) => {
        if (r.path.endsWith("/manifest")) return json(manifestFor(members));
        if (r.path.endsWith("/download")) return new Response(zipFor(members), { status: 200 });
        if (r.path.includes("/files/")) return new Response("", { status: 429, headers: { "retry-after": "2" } });
      });
      const flags = flagsFor();
      const run = await runAdd("plugin:o/p", flags, depsFor(flags, f));
      expect(run.exitCode).toBe(1);
      expect(run.blocked).toEqual([{ name: "alpha", reason: "could not fetch agents/openai.yaml: HTTP 429, retry in 2 s" }]);
      // Not a SKILL.md-only copy: nothing of it is installed.
      expect(existsSync(installed(flags, "alpha"))).toBe(false);
      expect(existsSync(installed(flags, "beta"))).toBe(true);
      expect(stripAnsi(run.output)).toContain("could not fetch agents/openai.yaml: HTTP 429, retry in 2 s");
      expect(stripAnsi(run.output)).not.toMatch(/only SKILL\.md/i);
    });
  });

  it("falls over to the plain failure when the registry stays rate limited", async () => {
    const { f } = fakeFetch((r) => {
      if (r.path.endsWith("/manifest")) return new Response("", { status: 429, headers: { "retry-after": "37" } });
      if (r.path.endsWith("/download")) return new Response(zipFor([{ name: "alpha" }]), { status: 200 });
    });
    const flags = flagsFor({ json: true });
    const run = await runAdd("plugin:o/p", flags, depsFor(flags, f));
    expect(run.exitCode).toBe(1);
    expect(JSON.parse(run.output).error).toBe("rate limited by the SkillMD API, try again in 37 s");
  });

  it("rides out a busy-D1 503 on the manifest", async () => {
    const members: MemberSpec[] = [{ name: "alpha" }];
    let n = 0;
    const { f } = fakeFetch((r) => {
      if (r.path.endsWith("/manifest")) return n++ < 2 ? json({ error: "temporarily_unavailable" }, 503) : json(manifestFor(members));
      if (r.path.endsWith("/download")) return new Response(zipFor(members), { status: 200 });
    });
    const flags = flagsFor();
    const c = clock();
    const run = await runAdd("plugin:o/p", flags, depsFor(flags, f, c));
    expect(run.exitCode).toBe(0);
    expect(c.waits).toEqual([1000, 2000]);
    expect(existsSync(installed(flags, "alpha"))).toBe(true);
  });

  it("keeps the unchecked-companion remark out of the terminal and in --json warnings", async () => {
    const members: MemberSpec[] = [{ name: "alpha", files: [{ path: "a.md", body: "A", sha: "none" }] }];
    const { f } = fakeFetch((r) => {
      if (r.path.endsWith("/manifest")) return json(manifestFor(members));
      if (r.path.endsWith("/download")) return new Response(zipFor(members), { status: 200 });
    });
    const human = flagsFor();
    const run = await runAdd("plugin:o/p", human, depsFor(human, f));
    expect(run.exitCode).toBe(0);
    expect(stripAnsi(run.output)).not.toMatch(/checksum/);
    const js = flagsFor({ json: true });
    const doc = JSON.parse((await runAdd("plugin:o/p", js, depsFor(js, f))).output);
    expect(doc.warnings.some((w: string) => /no checksum/.test(w))).toBe(true);
  });
});

describe("plugin install without a manifest (an older or self-hosted registry)", () => {
  const members: MemberSpec[] = [
    { name: "alpha", files: [{ path: "a.md", body: "A" }] },   // a pack
    { name: "beta" },                                           // a single
    { name: "gamma", files: [{ path: "g.md", body: "G" }] },   // a pack
    { name: "delta", files: [{ path: "d.md", body: "D" }] },   // a pack
    { name: "epsilon", files: [{ path: "e.md", body: "E" }] }, // a pack
    { name: "zeta", files: [{ path: "z.md", body: "Z" }] },    // a pack
  ];
  const bundle = (m: MemberSpec) => ({
    files: [
      { path: "SKILL.md", content_base64: Buffer.from(skillMd(m.name)).toString("base64"), sha256: sha(skillMd(m.name)) },
      ...(m.files ?? []).map((x) => ({ path: x.path, content_base64: Buffer.from(x.body).toString("base64"), sha256: sha(x.body) })),
    ],
  });

  function legacy(over: (r: Req) => Response | undefined = () => undefined) {
    return fakeFetch((r) => {
      const o = over(r);
      if (o) return o;
      if (r.path.endsWith("/manifest")) return json({ error: "not_found" }, 404);
      if (r.path.endsWith("/download")) return new Response(zipFor(members), { status: 200 });
      if (r.path.startsWith("/api/packs/o/p?")) {
        return json({ name: "Test Plugin", item_total: members.length, items: members.map((m) => ({ slug: slugOf(m), type: m.files?.length ? "pack" : "single", verified: false })) });
      }
      const b = /^\/api\/skills\/o\/([^/]+)\/bundle/.exec(r.path);
      if (b) return json(bundle(members.find((m) => m.name === b[1])!));
    });
  }

  it("lists the members, takes the archive once, and fetches bundles for packs only", async () => {
    const { f, log } = legacy();
    const flags = flagsFor();
    const run = await runAdd("plugin:o/p", flags, depsFor(flags, f));
    expect(run.exitCode).toBe(0);
    expect(run.written).toHaveLength(6);
    expect(log.filter((r) => r.path.endsWith("/download"))).toHaveLength(1); // the one asked for alongside the manifest
    expect(log.filter((r) => r.path.includes("/bundle")).map((r) => r.path.split("/")[4]).sort()).toEqual(["alpha", "delta", "epsilon", "gamma", "zeta"]);
    expect(readFileSync(installed(flags, "gamma", "g.md"), "utf8")).toBe("G");
  });

  it("paces the bundle requests to about four a second, four at a time", async () => {
    let inFlight = 0;
    let peak = 0;
    // A frozen clock: every request is ready at the same instant, so the waits
    // the pacer asks for are exactly the slots it hands out.
    const waits: number[] = [];
    const frozen = { now: () => 1_000_000, sleep: async (ms: number) => { waits.push(ms); }, opts: { jitter: () => 0 }, waits };
    const { f } = legacy((r) => {
      if (r.path.includes("/bundle")) { inFlight++; peak = Math.max(peak, inFlight); }
      return undefined;
    });
    const slow = (async (u: string | URL | Request, init?: RequestInit) => {
      const res = await f(u, init);
      if (String(u).includes("/bundle")) { await new Promise((r) => setTimeout(r, 3)); inFlight--; }
      return res;
    }) as unknown as typeof fetch;
    const flags = flagsFor();
    const run = await runAdd("plugin:o/p", flags, depsFor(flags, slow, frozen));
    expect(run.exitCode).toBe(0);
    expect(peak).toBeLessThanOrEqual(4);
    // Five bundles: the first goes at once, each next one a quarter of a second after the one before.
    expect([...waits].sort((a, b) => a - b)).toEqual([250, 500, 750, 1000]);
  });

  it("retries a bundle that answers 429 and installs the member", async () => {
    let tries = 0;
    const { f } = legacy((r) => {
      if (r.path.includes("/bundle") && r.path.includes("/alpha/") && tries++ === 0) return new Response("", { status: 429, headers: { "retry-after": "1" } });
    });
    const flags = flagsFor();
    const run = await runAdd("plugin:o/p", flags, depsFor(flags, f));
    expect(run.exitCode).toBe(0);
    expect(readFileSync(installed(flags, "alpha", "a.md"), "utf8")).toBe("A");
  });

  it("no longer installs a pack as SKILL.md only when its bundle will not come", async () => {
    const { f } = legacy((r) => (r.path.includes("/bundle") && r.path.includes("/gamma/") ? new Response("", { status: 429, headers: { "retry-after": "2" } }) : undefined));
    const flags = flagsFor();
    const run = await runAdd("plugin:o/p", flags, depsFor(flags, f));
    expect(run.exitCode).toBe(1);
    expect(run.blocked).toHaveLength(1);
    expect(run.blocked[0]!.name).toBe("gamma");
    expect(run.blocked[0]!.reason).toMatch(/HTTP 429, retry in 2 s/);
    expect(existsSync(installed(flags, "gamma"))).toBe(false);
    expect(run.written.map((w) => w.name)).toContain("alpha");
    expect(stripAnsi(run.output)).not.toMatch(/only SKILL\.md/i);
  });

  it("blocks a member whose bundle fails its checksum instead of installing its SKILL.md", async () => {
    const { f } = legacy((r) => {
      if (!(r.path.includes("/bundle") && r.path.includes("/delta/"))) return undefined;
      return json({ files: [{ path: "d.md", content_base64: Buffer.from("TAMPERED").toString("base64"), sha256: sha("D") }] });
    });
    const flags = flagsFor();
    const run = await runAdd("plugin:o/p", flags, depsFor(flags, f));
    expect(run.blocked.map((b) => b.name)).toEqual(["delta"]);
    expect(run.blocked[0]!.reason).toMatch(/integrity check failed/);
    expect(existsSync(installed(flags, "delta"))).toBe(false);
  });

  it("installs a pack that legitimately has no companions", async () => {
    const { f } = legacy((r) => (r.path.includes("/bundle") && r.path.includes("/zeta/")
      ? json({ files: [{ path: "SKILL.md", content_base64: Buffer.from(skillMd("zeta")).toString("base64") }] })
      : undefined));
    const flags = flagsFor();
    const run = await runAdd("plugin:o/p", flags, depsFor(flags, f));
    expect(run.exitCode).toBe(0);
    expect(existsSync(installed(flags, "zeta"))).toBe(true);
    expect(stripAnsi(run.output)).not.toMatch(/only SKILL\.md/i);
  });

  it("says plainly that the plugin does not exist when nothing answers for it", async () => {
    const f = (async () => new Response(JSON.stringify({ error: "not_found" }), { status: 404 })) as unknown as typeof fetch;
    const flags = flagsFor({ json: true });
    const run = await runAdd("plugin:o/nope", flags, depsFor(flags, f));
    expect(run.exitCode).toBe(1);
    expect(JSON.parse(run.output).error).toMatch(/404.*\/api\/packs\/o\/nope/);
  });
});

describe("install pings", () => {
  it("never has more than four in flight, and does not retry a failed one", async () => {
    let inFlight = 0;
    let peak = 0;
    const attempts: string[] = [];
    const { f } = fakeFetch(async (r) => {
      attempts.push(r.path);
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((res) => setTimeout(res, 5));
      inFlight--;
      return r.path.includes("/skill-3/") ? new Response("", { status: 429, headers: { "retry-after": "1" } }) : json({ ok: true });
    });
    const flags = flagsFor({ env: {} });
    const deps = makeDefaultDeps(flags, { fetch: f, sources: { env: {}, config: {} }, retry: { sleep: async () => {} } });
    for (let i = 0; i < 12; i++) deps.fireInstall(`o/skill-${i}`, flags);
    await vi.waitFor(() => expect(attempts).toHaveLength(12));
    await new Promise((r) => setTimeout(r, 20));
    expect(peak).toBe(4);
    expect(attempts).toHaveLength(12); // the 429 was not tried again
    expect(attempts.every((p) => p.endsWith("/install"))).toBe(true);
  });

  it("is not sent at all when telemetry is off", async () => {
    const members: MemberSpec[] = [{ name: "alpha" }];
    const { f, log } = fakeFetch((r) => {
      if (r.path.endsWith("/manifest")) return json(manifestFor(members));
      if (r.path.endsWith("/download")) return new Response(zipFor(members), { status: 200 });
    });
    const flags = flagsFor(); // SKILLMD_NO_TELEMETRY=1
    await runAdd("plugin:o/p", flags, depsFor(flags, f));
    expect(log.some((r) => r.method === "POST")).toBe(false);
  });

  it("does not hold the install up for a ping that never answers", async () => {
    const members: MemberSpec[] = [{ name: "alpha" }, { name: "beta" }];
    const { f } = fakeFetch((r) => {
      if (r.path.endsWith("/manifest")) return json(manifestFor(members));
      if (r.path.endsWith("/download")) return new Response(zipFor(members), { status: 200 });
      if (r.method === "POST") return new Promise<Response>(() => {}) as never; // never answers
    });
    const flags = flagsFor({ env: {} });
    const run = await runAdd("plugin:o/p", flags, depsFor(flags, f));
    expect(run.exitCode).toBe(0);
    expect(run.written).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// What a multi-skill run says. One header, one line per skill, the problems
// together after them, one summary. Nothing else in a normal run.
// ---------------------------------------------------------------------------
describe("the terminal output of a plugin install", () => {
  const AGENTS = ["cursor", "codex", "windsurf", "opencode", "gemini-cli"];
  const members: MemberSpec[] = Array.from({ length: 39 }, (_, i) => ({
    name: `skill-${String(i).padStart(2, "0")}`,
    // Companions the registry holds no checksum for: the remark that used to
    // be printed once per skill.
    files: i % 4 === 0 ? [{ path: "agents/openai.yaml", body: `agent ${i}`, sha: "none" as const }] : [],
  }));
  const registry = (over: (r: Req) => Response | undefined = () => undefined) => fakeFetch((r) => {
    const o = over(r);
    if (o) return o;
    if (r.path.endsWith("/manifest")) return json(manifestFor(members));
    if (r.path.endsWith("/download")) return new Response(zipFor(members), { status: 200 });
  });
  const withClock = (flags: AddFlags, f: typeof fetch) => {
    const ticks = [10_000, 14_234]; // the run starts at 10.000 s and ends at 14.234 s
    let i = 0;
    return { ...depsFor(flags, f), now: () => ticks[Math.min(i++, ticks.length - 1)]! };
  };

  it("is the header, 39 skill lines and the summary, and nothing else", async () => {
    const { f } = registry();
    const flags = flagsFor({ agent: AGENTS });
    const run = await runAdd("plugin:o/p", flags, withClock(flags, f));
    expect(run.exitCode).toBe(0);
    const lines = stripAnsi(run.output).split("\n");
    expect(lines).toHaveLength(41);
    expect(lines[0]).toBe("Installing Test Plugin, 39 skills, to 5 agents");
    expect(lines[1]).toBe("✓ skill-00  score 100  docs_only");
    expect(lines.slice(1, 40).every((l) => /^✓ skill-\d\d  score \d+/.test(l))).toBe(true);
    expect(lines[40]).toMatch(/^39 installed · 5 agents \(cursor, codex, windsurf, opencode, gemini-cli\) · (linked|copied|canonical)( \+ (linked|copied|canonical))? · 4\.2 s$/);
  });

  it("carries none of the noise it used to", async () => {
    const { f } = registry();
    const flags = flagsFor({ agent: AGENTS });
    const out = stripAnsi((await runAdd("plugin:o/p", flags, withClock(flags, f))).output);
    expect(out).not.toMatch(/skill-00: 39 skills from/);                // the header says it
    expect(out).not.toMatch(/came straight from the source repo|no checksum/); // internal detail
    expect(out).not.toMatch(/\bjunction\b|\.cursor\/skills|~\/\.cursor/);      // a line per agent per skill
    expect(out).not.toContain("⚠");                                      // warnings are for failures
  });

  it("puts every failure together after the skill lines, with its reason", async () => {
    // skill-04 lists a companion; take it out of the archive so it becomes a gap that 429s.
    const gapped = members.map((m) => (m.name === "skill-04" || m.name === "skill-08" ? { ...m, files: m.files!.map((x) => ({ ...x, inZip: false })) } : m));
    const reg = fakeFetch((r) => {
      if (r.path.endsWith("/manifest")) return json(manifestFor(gapped));
      if (r.path.endsWith("/download")) return new Response(zipFor(gapped), { status: 200 });
      if (r.path.includes("/files/")) return new Response("", { status: 429, headers: { "retry-after": "2" } });
    });
    const flags = flagsFor({ agent: AGENTS });
    const run = await runAdd("plugin:o/p", flags, withClock(flags, reg.f));
    expect(run.exitCode).toBe(1);
    const lines = stripAnsi(run.output).split("\n");
    expect(lines).toHaveLength(1 + 37 + 2 + 1);
    expect(lines.slice(1, 38).every((l) => l.startsWith("✓ "))).toBe(true);
    expect(lines.slice(38, 40)).toEqual([
      "✗ skill-04  could not fetch agents/openai.yaml: HTTP 429, retry in 2 s",
      "✗ skill-08  could not fetch agents/openai.yaml: HTTP 429, retry in 2 s",
    ]);
    expect(lines[40]).toMatch(/^37 installed, 2 failed · 5 agents /);
  });

  it("names a member that is missing from the archive among the problems", async () => {
    const reg = fakeFetch((r) => {
      if (r.path.endsWith("/manifest")) return json(manifestFor(members.slice(0, 3)));
      if (r.path.endsWith("/download")) return new Response(zipFor(members.slice(0, 3), ["skill-01"]), { status: 200 });
    });
    const flags = flagsFor({ agent: AGENTS });
    const run = await runAdd("plugin:o/p", flags, withClock(flags, reg.f));
    const lines = stripAnsi(run.output).split("\n");
    expect(lines[0]).toBe("Installing Test Plugin, 2 skills, to 5 agents");
    expect(lines).toContain("⚠ o/skill-01: not in the plugin archive");
    expect(lines.at(-1)).toMatch(/^2 installed · /);
  });

  it("leaves --json as it was: the same document, with the quiet remarks still among the warnings", async () => {
    const { f } = registry();
    const flags = flagsFor({ agent: AGENTS, json: true });
    const doc = JSON.parse((await runAdd("plugin:o/p", flags, depsFor(flags, f))).output);
    expect(Object.keys(doc)).toEqual(["ok", "scope", "installed", "blocked", "warnings"]);
    expect(doc.installed).toHaveLength(39);
    expect(doc.warnings).toContain("skill-00: 39 skills from the Test Plugin plugin");
    expect(doc.warnings.some((w: string) => /no checksum/.test(w))).toBe(true);
  });

  it("is still the plain single-skill block when one skill is picked out of the plugin", async () => {
    const { f } = registry();
    const flags = flagsFor({ agent: ["cursor"], skill: ["skill-04"] });
    const run = await runAdd("plugin:o/p", flags, depsFor(flags, f));
    const out = stripAnsi(run.output);
    expect(out).toMatch(/^✓ skill-04  score \d+/);
    expect(out).toMatch(/\bcursor\b.*\.cursor/); // the per-agent row a single skill has always had
    expect(out).not.toMatch(/^Installing /m);
  });
});

// ---------------------------------------------------------------------------
// Pointer skills. mattpocock/grill-me has a whole body of `Call the Skill tool
// with "grilling".`: installed alone it is an empty shell, so the skill it
// points at comes with it. A pointer that leads nowhere is not worth a word.
// ---------------------------------------------------------------------------
describe("pointer skills", () => {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
  const doc = (name: string, extra = "") => skillMd(name).replace(`# ${name}\n`, `# ${name}\n\n${extra}\n`);

  interface Reg { extra?: string; repo?: string | null; status?: number; raw?: string }
  /** A registry that answers `/api/skills/o/<name>` and its bundle for the skills it is given. */
  function registry(skills: Record<string, Reg>, more: (r: Req) => Response | undefined = () => undefined) {
    return fakeFetch((r) => {
      const o = more(r);
      if (o) return o;
      const m = /^\/api\/skills\/o\/([^/?]+)(\/bundle)?/.exec(r.path);
      const s = m && skills[m[1]!];
      if (!m || !s) return undefined;
      if (s.status) return new Response("", { status: s.status });
      const raw = s.raw ?? doc(m[1]!, s.extra);
      if (m[2]) return json({ files: [{ path: "SKILL.md", content_base64: b64(raw), storage: "inline" }] });
      return json({ slug: `o/${m[1]}`, title: m[1], description: "d", type: "single", verified: false, source_repo: s.repo === undefined ? "o/skills" : s.repo, raw_md: raw });
    });
  }
  const POINT = (n: string) => `Call the Skill tool with "${n}".`;
  const lines = (out: string) => stripAnsi(out).split("\n");
  const asked = (log: Req[]) => log.filter((r) => /^\/api\/skills\/o\/[^/?]+$/.test(r.path)).map((r) => r.path.split("/").pop());

  it("installs the skill it points at too, with one plain line saying so", async () => {
    const { f } = registry({ "grill-me": { extra: POINT("grilling") }, grilling: {} });
    const flags = flagsFor({ agent: ["cursor", "codex"] });
    const run = await runAdd("o/grill-me", flags, depsFor(flags, f));
    expect(run.exitCode).toBe(0);
    expect(existsSync(installed(flags, "grill-me"))).toBe(true);
    expect(existsSync(installed(flags, "grilling"))).toBe(true);
    const out = lines(run.output);
    expect(out.filter((l) => l.startsWith("also installs"))).toEqual(["also installs grilling (used by grill-me)"]);
    // The header names what was asked for, not "2 skills, 2 skills".
    expect(out[0]).toBe("Installing o/grill-me, 2 skills, to 2 agents");
    expect(out.at(-1)).toMatch(/^2 installed · 2 agents \(cursor, codex\) · /);
    expect(run.output).not.toContain("⚠");
    // The info line carries no colour at all.
    expect(run.output.split("\n").find((l) => l.includes("also installs"))).toBe("also installs grilling (used by grill-me)");
  });

  it("says nothing, and still succeeds, when what it points at does not exist", async () => {
    const { f, log } = registry({ "grill-me": { extra: POINT("grilling") } });
    const flags = flagsFor({ agent: ["cursor"] });
    const run = await runAdd("o/grill-me", flags, depsFor(flags, f));
    expect(run.exitCode).toBe(0);
    expect(asked(log)).toContain("grilling"); // it was looked for
    expect(existsSync(installed(flags, "grill-me"))).toBe(true);
    const out = stripAnsi(run.output);
    expect(out).not.toMatch(/also installs|grilling|⚠/);
    expect(out).toMatch(/^✓ grill-me  score \d+/); // the ordinary single-skill block
  });

  it("says nothing when the lookup itself fails", async () => {
    const { f } = registry({ "grill-me": { extra: POINT("grilling") }, grilling: { status: 500 } });
    const flags = flagsFor({ agent: ["cursor"] });
    const run = await runAdd("o/grill-me", flags, depsFor(flags, f));
    expect(run.exitCode).toBe(0);
    expect(stripAnsi(run.output)).not.toMatch(/also installs|grilling|⚠/);
    expect(existsSync(installed(flags, "grilling"))).toBe(false);
  });

  it("does not take a skill of the same name from a different source repository", async () => {
    const { f } = registry({ "grill-me": { extra: POINT("grilling"), repo: "o/skills" }, grilling: { repo: "someone-else/other-repo" } });
    const flags = flagsFor({ agent: ["cursor"] });
    const run = await runAdd("o/grill-me", flags, depsFor(flags, f));
    expect(run.exitCode).toBe(0);
    expect(existsSync(installed(flags, "grilling"))).toBe(false);
    expect(stripAnsi(run.output)).not.toMatch(/also installs/);
  });

  it("takes it when either record has no source repository to compare", async () => {
    const { f } = registry({ "grill-me": { extra: POINT("grilling"), repo: null }, grilling: { repo: "o/skills" } });
    const flags = flagsFor({ agent: ["cursor"] });
    await runAdd("o/grill-me", flags, depsFor(flags, f));
    expect(existsSync(installed(flags, "grilling"))).toBe(true);
  });

  it("ends a cycle and installs each skill once", async () => {
    const { f, log } = registry({ alpha: { extra: POINT("beta") }, beta: { extra: POINT("alpha") } });
    const flags = flagsFor({ agent: ["cursor"] });
    const run = await runAdd("o/alpha", flags, depsFor(flags, f));
    expect(run.exitCode).toBe(0);
    expect(run.written).toHaveLength(2);
    expect(lines(run.output).filter((l) => l.startsWith("also installs"))).toEqual(["also installs beta (used by alpha)"]);
    expect(asked(log).filter((n) => n === "alpha")).toHaveLength(1); // never fetched again as a pointer
  });

  it("follows a pointer of a pointer, and stops there", async () => {
    const { f, log } = registry({
      alpha: { extra: POINT("beta") }, beta: { extra: POINT("gamma") }, gamma: { extra: POINT("delta") },
      delta: { extra: POINT("epsilon") }, epsilon: {},
    });
    const flags = flagsFor({ agent: ["cursor"] });
    const run = await runAdd("o/alpha", flags, depsFor(flags, f));
    expect(run.written.map((w) => w.name).sort()).toEqual(["alpha", "beta", "gamma"]);
    expect(lines(run.output).filter((l) => l.startsWith("also installs"))).toEqual([
      "also installs beta (used by alpha)",
      "also installs gamma (used by beta)",
    ]);
    expect(asked(log)).not.toContain("delta");
    expect(existsSync(installed(flags, "delta"))).toBe(false);
  });

  it("leaves alone a pointed skill that is already installed, whatever it came from", async () => {
    const flags = flagsFor({ agent: ["cursor"] });
    await runAdd("x/grilling", flags, { resolve: async () => [{ name: "grilling", slug: "grilling", raw: skillMd("grilling"), source: "github:x/other" }], fireInstall: () => {} });
    const { f } = registry({ "grill-me": { extra: POINT("grilling") }, grilling: {} });
    const run = await runAdd("o/grill-me", flags, depsFor(flags, f));
    expect(run.exitCode).toBe(0);
    expect(run.blocked).toEqual([]);
    expect(stripAnsi(run.output)).not.toMatch(/also installs/);
    expect(readFileSync(installed(flags, "grilling"), "utf8")).toContain("name: grilling");
  });

  it("gives a pointed skill that fails its checks the ordinary blocked record, and nothing extra", async () => {
    const { f } = registry({ "grill-me": { extra: POINT("grilling") }, grilling: { raw: "---\nname: grilling\n---\nno description" } });
    const flags = flagsFor({ agent: ["cursor"] });
    const run = await runAdd("o/grill-me", flags, depsFor(flags, f));
    expect(run.blocked).toHaveLength(1);
    expect(run.blocked[0]!.name).toBe("grilling");
    expect(existsSync(installed(flags, "grill-me"))).toBe(true);
    expect(stripAnsi(run.output)).not.toMatch(/also installs/);
  });

  it("does not go looking for pointers when only listing", async () => {
    const { f, log } = registry({ "grill-me": { extra: POINT("grilling") }, grilling: {} });
    const flags = flagsFor({ list: true });
    const run = await runAdd("o/grill-me", flags, depsFor(flags, f));
    expect(stripAnsi(run.output)).toContain("grill-me");
    expect(asked(log)).not.toContain("grilling");
  });

  it("adds the pointed skill to --json's installed list, and names it in alsoInstalled", async () => {
    const { f } = registry({ "grill-me": { extra: POINT("grilling") }, grilling: {} });
    const flags = flagsFor({ agent: ["cursor"], json: true });
    const doc = JSON.parse((await runAdd("o/grill-me", flags, depsFor(flags, f))).output);
    expect(Object.keys(doc)).toEqual(["ok", "scope", "installed", "blocked", "warnings", "alsoInstalled"]);
    expect(doc.installed.map((i: { name: string }) => i.name)).toEqual(["grill-me", "grilling"]);
    expect(doc.alsoInstalled).toEqual([{ name: "grilling", usedBy: "grill-me" }]);
  });

  it("leaves --json exactly as it was when nothing is pointed at", async () => {
    const { f } = registry({ plain: {} });
    const flags = flagsFor({ agent: ["cursor"], json: true });
    const doc = JSON.parse((await runAdd("o/plain", flags, depsFor(flags, f))).output);
    expect(Object.keys(doc)).toEqual(["ok", "scope", "installed", "blocked", "warnings"]);
  });

  describe("inside a plugin", () => {
    const members: MemberSpec[] = [{ name: "grill-me" }, { name: "grilling" }, { name: "other", files: [{ path: "gap.md", body: "G", inZip: false }] }, { name: "more" }];
    // grill-me's SKILL.md points at grilling.
    const zip = () => {
      const entries: Record<string, Uint8Array> = {};
      for (const m of members) {
        entries[`${m.name}/SKILL.md`] = strToU8(m.name === "grill-me" ? doc("grill-me", POINT("grilling")) : skillMd(m.name));
        for (const f of m.files ?? []) if (f.inZip !== false) entries[`${m.name}/${f.path}`] = strToU8(f.body);
      }
      return zipSync(entries);
    };
    const pluginRegistry = () => fakeFetch((r) => {
      if (r.path.endsWith("/manifest")) return json(manifestFor(members));
      if (r.path.endsWith("/download")) return new Response(zip(), { status: 200 });
      if (r.path.includes("/files/")) return new Response("G", { status: 200 });
    });

    it("does not say 'also installs' for a member that is already part of the run", async () => {
      const { f } = pluginRegistry();
      const flags = flagsFor({ agent: ["cursor"] });
      const run = await runAdd("plugin:o/p", flags, depsFor(flags, f));
      expect(run.written).toHaveLength(4);
      expect(stripAnsi(run.output)).not.toMatch(/also installs/);
      expect(run.written.filter((w) => w.name === "grilling")).toHaveLength(1); // once
    });

    it("pulls in the member a selected skill points at, and fetches nothing for the rest", async () => {
      const { f, log } = pluginRegistry();
      const flags = flagsFor({ agent: ["cursor"], skill: ["grill-me"] });
      const run = await runAdd("plugin:o/p", flags, depsFor(flags, f));
      expect(run.exitCode).toBe(0);
      expect(run.written.map((w) => w.name).sort()).toEqual(["grill-me", "grilling"]);
      expect(lines(run.output).filter((l) => l.startsWith("also installs"))).toEqual(["also installs grilling (used by grill-me)"]);
      expect(existsSync(installed(flags, "other"))).toBe(false);
      // `other` has a companion the archive lacks: not selected, so not asked for.
      expect(log.some((r) => r.path.includes("/files/"))).toBe(false);
    });

    it("looks to the same owner in the registry for a pointer that is not a member", async () => {
      const lone: MemberSpec[] = [{ name: "grill-me" }];
      const reg = fakeFetch((r) => {
        if (r.path.endsWith("/manifest")) return json(manifestFor(lone));
        if (r.path.endsWith("/download")) return new Response(zipSync({ "grill-me/SKILL.md": strToU8(doc("grill-me", POINT("grilling"))) }), { status: 200 });
        const m = /^\/api\/skills\/o\/grilling(\/bundle)?/.exec(r.path);
        if (m && m[1]) return json({ files: [{ path: "SKILL.md", content_base64: b64(skillMd("grilling")), storage: "inline" }] });
        if (m) return json({ slug: "o/grilling", title: "grilling", description: "d", type: "single", verified: false, raw_md: skillMd("grilling") });
      });
      const flags = flagsFor({ agent: ["cursor"], skill: ["grill-me"] });
      const run = await runAdd("plugin:o/p", flags, depsFor(flags, reg.f));
      expect(run.written.map((w) => w.name).sort()).toEqual(["grill-me", "grilling"]);
      expect(lines(run.output)).toContain("also installs grilling (used by grill-me)");
    });
  });
});

describe("--skill and --list on a plugin", () => {
  const members: MemberSpec[] = [
    { name: "alpha", files: [{ path: "gap.md", body: "G", inZip: false }] },
    { name: "beta" },
  ];
  const reg = () => fakeFetch((r) => {
    if (r.path.endsWith("/manifest")) return json(manifestFor(members));
    if (r.path.endsWith("/download")) return new Response(zipFor(members), { status: 200 });
    if (r.path.includes("/files/")) return new Response("G", { status: 200 });
  });

  it("--list names every member and fetches no companion", async () => {
    const { f, log } = reg();
    const flags = flagsFor({ list: true });
    const run = await runAdd("plugin:o/p", flags, depsFor(flags, f));
    expect(stripAnsi(run.output)).toMatch(/alpha[\s\S]*beta/);
    expect(log.some((r) => r.path.includes("/files/"))).toBe(false);
  });

  it("--skill that names nothing in the plugin installs nothing, and says exit 1", async () => {
    const { f } = reg();
    const flags = flagsFor({ skill: ["nope"] });
    const run = await runAdd("plugin:o/p", flags, depsFor(flags, f));
    expect(run.written).toEqual([]);
    expect(run.exitCode).toBe(1);
  });

  it("--skill fetches only the companions of the member it names", async () => {
    const { f, log } = reg();
    const flags = flagsFor({ skill: ["beta"] });
    const run = await runAdd("plugin:o/p", flags, depsFor(flags, f));
    expect(run.written.map((w) => w.name)).toEqual(["beta"]);
    expect(log.some((r) => r.path.includes("/files/"))).toBe(false);
  });
});

describe("a pointer in a source that is already all there", () => {
  const withBody = (name: string, extra: string) => skillMd(name).replace(`# ${name}\n`, `# ${name}\n\n${extra}\n`);
  it("pulls a sibling in when one skill is picked out of a repo", async () => {
    const pool = [
      { name: "grill-me", slug: "grill-me", raw: withBody("grill-me", 'Call the Skill tool with "grilling".'), source: "github:o/skills" },
      { name: "grilling", slug: "grilling", raw: skillMd("grilling"), source: "github:o/skills" },
      { name: "unrelated", slug: "unrelated", raw: skillMd("unrelated"), source: "github:o/skills" },
    ];
    const flags = flagsFor({ agent: ["cursor"], skill: ["grill-me"] });
    const run = await runAdd("o/skills", flags, { resolve: async () => pool, fireInstall: () => {} });
    expect(run.written.map((w) => w.name).sort()).toEqual(["grill-me", "grilling"]);
    expect(stripAnsi(run.output)).toContain("also installs grilling (used by grill-me)");
    expect(existsSync(installed(flags, "unrelated"))).toBe(false);
  });
});
