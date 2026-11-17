// `add` and the skills a skill depends on, end to end against a fake registry.
//
// Hard dependencies (skill_tool, invoke) install on their own, silently, with one
// plain line each. Soft ones (see, link) are only listed as related. The registry's
// closure endpoint is asked first, once per root; its absence (any failure at all)
// sends the run to the SKILL.md bodies. Nothing here touches the network: every
// request goes through an injected fetch, every wait through an injected sleeper.
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { makeDefaultDeps, runAdd } from "./add.js";
import type { AddFlags } from "./add.js";
import { stripAnsi } from "../ui.js";

vi.mock("../claudePlugin.js", async (orig) => ({
  ...(await orig<typeof import("../claudePlugin.js")>()),
  claudeCliAvailable: async () => false,
  installPluginNatively: async () => ({ ok: false, reason: "no Claude Code directory on this machine" }),
}));

const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "skillmd-deps-")); tmps.push(d); return d; };
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });

const BASE = "https://api.test";
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const skillMd = (name: string, extra = "") =>
  `---\nname: ${name}\ndescription: A complete skill that explains how to do the ${name} thing and when to reach for it.\nlicense: MIT\n---\n# ${name}\n\n${extra}\n${"Plenty of detailed body content well past two hundred characters in total. ".repeat(3)}\n`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Req = { method: string; path: string };
function fakeFetch(route: (r: Req) => Response | undefined | Promise<Response | undefined>) {
  const log: Req[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    const r = { method: init?.method ?? "GET", path: u.pathname + u.search };
    log.push(r);
    return (await route(r)) ?? new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { f, log };
}

const edge = (slug: string, kind: string, depth: number, via: string) => ({ slug, kind, depth, via });
type Closure = ReturnType<typeof edge>[] | { deps: ReturnType<typeof edge>[]; truncated?: boolean } | number | "network";

interface Reg { extra?: string; repo?: string | null; raw?: string; status?: number }
/** A registry with `skills` under owner `o`, and a closure (or a failure) per root. */
function registry(skills: Record<string, Reg>, closures: Record<string, Closure> = {}, more: (r: Req) => Response | undefined = () => undefined) {
  return fakeFetch((r) => {
    const o = more(r);
    if (o) return o;
    const d = /^\/api\/skills\/(o\/[^/?]+)\/deps\?/.exec(r.path);
    if (d) {
      const c = closures[d[1]!];
      if (c === undefined) return undefined; // 404: no such route
      if (c === "network") throw new TypeError("fetch failed");
      if (typeof c === "number") return new Response("", { status: c });
      const body = Array.isArray(c) ? { deps: c, truncated: false } : { truncated: false, ...c };
      return json({ slug: d[1], depth: 3, kinds: [], ...body });
    }
    const m = /^\/api\/skills\/o\/([^/?]+)(\/bundle)?/.exec(r.path);
    const s = m && skills[m[1]!];
    if (!m || !s) return undefined;
    if (s.status) return new Response("", { status: s.status });
    const raw = s.raw ?? skillMd(m[1]!, s.extra);
    if (m[2]) return json({ files: [{ path: "SKILL.md", content_base64: b64(raw), storage: "inline" }] });
    return json({ slug: `o/${m[1]}`, title: m[1], description: "d", type: "single", verified: false, source_repo: s.repo === undefined ? "o/skills" : s.repo, raw_md: raw });
  });
}

function clock() {
  let t = 1_000_000;
  const waits: number[] = [];
  return { waits, now: () => t, sleep: async (ms: number) => { waits.push(ms); t += ms; } };
}
function flagsFor(extra: Partial<AddFlags> = {}): AddFlags {
  const home = tmp();
  return { cwd: home, home, global: true, yes: true, agent: ["cursor"], api: BASE, env: { SKILLMD_NO_TELEMETRY: "1" }, ...extra };
}
function depsFor(flags: AddFlags, f: typeof fetch, c = clock()) {
  return makeDefaultDeps(flags, { fetch: f, sources: { env: {}, config: {} }, retry: { sleep: c.sleep, now: c.now, jitter: () => 0 } });
}
const installed = (flags: AddFlags, name: string) => join(flags.home!, ".cursor", "skills", name, "SKILL.md");
const lines = (out: string) => stripAnsi(out).split("\n");
const depRequests = (log: Req[]) => log.filter((r) => r.path.includes("/deps?")).map((r) => r.path.split("/").slice(3, 5).join("/"));
const POINT = (n: string) => `Call the Skill tool with "${n}".`;

describe("the registry's closure endpoint", () => {
  it("is asked once, and what it names as hard installs, though the body says nothing", async () => {
    // grill-me's body does not mention grilling: only the endpoint can have found it.
    const { f, log } = registry({ "grill-me": {}, grilling: {} }, { "o/grill-me": [edge("o/grilling", "skill_tool", 1, "o/grill-me")] });
    const flags = flagsFor();
    const run = await runAdd("o/grill-me", flags, depsFor(flags, f));
    expect(run.exitCode).toBe(0);
    expect(depRequests(log)).toEqual(["o/grill-me"]);
    expect(existsSync(installed(flags, "grilling"))).toBe(true);
    expect(lines(run.output)).toContain("also installs grilling (used by grill-me)");
    // The request names the whole closure in one go.
    expect(log.find((r) => r.path.includes("/deps?"))!.path).toBe("/api/skills/o/grill-me/deps?depth=3&kinds=skill_tool,invoke,see,link");
  });

  it("makes one request however many dependencies there are, and none per dependency", async () => {
    const { f, log } = registry(
      { root: {}, a: {}, b: {}, c: {} },
      { "o/root": [edge("o/a", "invoke", 1, "o/root"), edge("o/b", "skill_tool", 2, "o/a"), edge("o/c", "invoke", 3, "o/b")] },
    );
    const flags = flagsFor();
    const run = await runAdd("o/root", flags, depsFor(flags, f));
    expect(run.written.map((w) => w.name).sort()).toEqual(["a", "b", "c", "root"]);
    expect(depRequests(log)).toEqual(["o/root"]);
  });

  it("is asked in place of reading the body", async () => {
    // The body names `ghost`; the endpoint says there is nothing. The endpoint wins.
    const { f, log } = registry({ root: { extra: POINT("ghost") }, ghost: {} }, { "o/root": [] });
    const flags = flagsFor();
    const run = await runAdd("o/root", flags, depsFor(flags, f));
    expect(run.written.map((w) => w.name)).toEqual(["root"]);
    expect(log.some((r) => r.path === "/api/skills/o/ghost")).toBe(false);
  });

  describe("when it is not there", () => {
    const failures: [string, Closure][] = [
      ["answers 404", 404],
      ["answers 500", 500],
      ["stays at 503", 503],
      ["is unreachable", "network"],
    ];
    for (const [what, closure] of failures) {
      it(`reads the body instead when it ${what}`, async () => {
        const { f } = registry({ root: { extra: POINT("grilling") }, grilling: {} }, { "o/root": closure });
        const flags = flagsFor();
        const run = await runAdd("o/root", flags, depsFor(flags, f));
        expect(run.exitCode).toBe(0);
        expect(existsSync(installed(flags, "grilling"))).toBe(true);
        expect(lines(run.output)).toContain("also installs grilling (used by root)");
        expect(stripAnsi(run.output)).not.toContain("⚠");
      });
    }

    it("reads the body instead when it answers something that is not a closure", async () => {
      const { f } = registry({ root: { extra: POINT("grilling") }, grilling: {} }, {}, (r) => (r.path.includes("/deps?") ? json({ nope: true }) : undefined));
      const flags = flagsFor();
      await runAdd("o/root", flags, depsFor(flags, f));
      expect(existsSync(installed(flags, "grilling"))).toBe(true);
    });

    it("rides out a busy 503 before giving up on it", async () => {
      let n = 0;
      const { f } = registry({ root: {}, grilling: {} }, {}, (r) => {
        if (!r.path.includes("/deps?")) return undefined;
        return n++ < 2 ? json({ error: "temporarily_unavailable" }, 503) : json({ deps: [edge("o/grilling", "invoke", 1, "o/root")] });
      });
      const flags = flagsFor();
      const c = clock();
      await runAdd("o/root", flags, depsFor(flags, f, c));
      expect(c.waits).toEqual([1000, 2000]);
      expect(existsSync(installed(flags, "grilling"))).toBe(true);
    });
  });

  it("does not install a hard dependency that hangs off a soft one, and lists both as related", async () => {
    const { f } = registry(
      { root: {}, soft: {}, hard: {} },
      { "o/root": [edge("o/soft", "see", 1, "o/root"), edge("o/hard", "skill_tool", 2, "o/soft")] },
    );
    const flags = flagsFor();
    const run = await runAdd("o/root", flags, depsFor(flags, f));
    expect(run.written.map((w) => w.name)).toEqual(["root"]);
    const out = lines(run.output);
    expect(out.at(-1)).toBe("related: soft, hard (add --with-related to install)");
    expect(out.filter((l) => l.startsWith("also installs"))).toEqual([]);
  });

  it("installs the soft ones as well with --with-related, and then has nothing left to list", async () => {
    const { f } = registry(
      { root: {}, soft: {}, hard: {} },
      { "o/root": [edge("o/soft", "see", 1, "o/root"), edge("o/hard", "skill_tool", 2, "o/soft")] },
    );
    const flags = flagsFor({ withRelated: true });
    const run = await runAdd("o/root", flags, depsFor(flags, f));
    expect(run.written.map((w) => w.name).sort()).toEqual(["hard", "root", "soft"]);
    const out = lines(run.output);
    expect(out).toContain("also installs soft (used by root)");
    expect(out).toContain("also installs hard (used by soft)");
    expect(out.some((l) => l.startsWith("related:"))).toBe(false);
  });

  it("skips a dependency the registry will not give (not public), saying nothing", async () => {
    const { f } = registry({ root: {}, other: {} }, { "o/root": [edge("o/private", "invoke", 1, "o/root"), edge("o/other", "invoke", 1, "o/root")] });
    const flags = flagsFor();
    const run = await runAdd("o/root", flags, depsFor(flags, f));
    expect(run.exitCode).toBe(0);
    expect(run.written.map((w) => w.name).sort()).toEqual(["other", "root"]);
    expect(stripAnsi(run.output)).not.toMatch(/private|⚠/);
  });

  it("installs what a truncated closure lists, and does not fail", async () => {
    const { f } = registry({ root: {}, a: {} }, { "o/root": { deps: [edge("o/a", "invoke", 1, "o/root")], truncated: true } });
    const flags = flagsFor();
    const run = await runAdd("o/root", flags, depsFor(flags, f));
    expect(run.exitCode).toBe(0);
    expect(run.written.map((w) => w.name).sort()).toEqual(["a", "root"]);
  });

  it("ends a cycle: a closure that lists the root again installs nothing twice", async () => {
    const { f } = registry(
      { a: {}, b: {} },
      { "o/a": [edge("o/b", "invoke", 1, "o/a"), edge("o/a", "invoke", 2, "o/b")] },
    );
    const flags = flagsFor();
    const run = await runAdd("o/a", flags, depsFor(flags, f));
    expect(run.written.map((w) => w.name).sort()).toEqual(["a", "b"]);
  });

  it("takes depth three as the registry reports it, without walking any further", async () => {
    const { f, log } = registry(
      { a: {}, b: {}, c: {}, d: {}, e: {} },
      { "o/a": [edge("o/b", "invoke", 1, "o/a"), edge("o/c", "invoke", 2, "o/b"), edge("o/d", "invoke", 3, "o/c")] },
    );
    const flags = flagsFor();
    const run = await runAdd("o/a", flags, depsFor(flags, f));
    expect(run.written.map((w) => w.name).sort()).toEqual(["a", "b", "c", "d"]);
    expect(depRequests(log)).toEqual(["o/a"]);
    expect(lines(run.output).filter((l) => l.startsWith("also installs"))).toEqual([
      "also installs b (used by a)", "also installs c (used by b)", "also installs d (used by c)",
    ]);
  });

  it("leaves a dependency that is already installed alone, silently", async () => {
    const flags = flagsFor();
    await runAdd("x/b", flags, { resolve: async () => [{ name: "b", slug: "b", raw: skillMd("b"), source: "github:x/other" }], fireInstall: () => {} });
    const { f } = registry({ a: {}, b: {} }, { "o/a": [edge("o/b", "invoke", 1, "o/a")] });
    const run = await runAdd("o/a", flags, depsFor(flags, f));
    expect(run.exitCode).toBe(0);
    expect(run.blocked).toEqual([]);
    expect(stripAnsi(run.output)).not.toMatch(/also installs/);
  });

  it("gives a dependency that fails its checks the ordinary blocked record, and keeps the root", async () => {
    const { f } = registry({ a: {}, b: { raw: "---\nname: b\n---\nno description" } }, { "o/a": [edge("o/b", "invoke", 1, "o/a")] });
    const flags = flagsFor();
    const run = await runAdd("o/a", flags, depsFor(flags, f));
    expect(run.blocked.map((b) => b.name)).toEqual(["b"]);
    expect(existsSync(installed(flags, "a"))).toBe(true);
    expect(stripAnsi(run.output)).not.toMatch(/also installs/);
  });
});

describe("--no-deps", () => {
  it("skips everything: no request for dependencies, only the root", async () => {
    const { f, log } = registry({ root: { extra: POINT("grilling") }, grilling: {} }, { "o/root": [edge("o/grilling", "skill_tool", 1, "o/root")] });
    const flags = flagsFor({ noDeps: true });
    const run = await runAdd("o/root", flags, depsFor(flags, f));
    expect(run.written.map((w) => w.name)).toEqual(["root"]);
    expect(depRequests(log)).toEqual([]);
    expect(log.some((r) => r.path === "/api/skills/o/grilling")).toBe(false);
    expect(stripAnsi(run.output)).not.toMatch(/also installs|related/);
  });

  it("is what commander's --no-deps becomes", async () => {
    const { addFlags } = await import("./add.js");
    expect(addFlags({ deps: false } as never).noDeps).toBe(true);
    expect(addFlags({} as never).noDeps).toBeUndefined();
    expect(addFlags({ withRelated: true } as never).withRelated).toBe(true);
  });
});

describe("what the terminal says", () => {
  it("is the header, the also-installs lines, the skills, the summary, and one related line", async () => {
    const { f } = registry(
      { root: {}, b: {}, c: {}, x: {}, y: {} },
      { "o/root": [edge("o/b", "skill_tool", 1, "o/root"), edge("o/c", "invoke", 2, "o/b"), edge("o/x", "see", 1, "o/root"), edge("o/y", "link", 1, "o/root")] },
    );
    const flags = flagsFor();
    const ticks = [0, 0, 0, 0];
    let i = 0;
    const run = await runAdd("o/root", flags, { ...depsFor(flags, f), now: () => ticks[Math.min(i++, ticks.length - 1)]! });
    const out = lines(run.output);
    expect(out[0]).toBe("Installing o/root, 3 skills, to 1 agent");
    expect(out.slice(1, 3)).toEqual(["also installs b (used by root)", "also installs c (used by b)"]);
    expect(out.slice(3, 6).map((l) => l.split("  ")[0])).toEqual(["✓ root", "✓ b", "✓ c"]);
    expect(out[6]).toBe("3 installed · 1 agent (cursor) · " + out[6]!.split(" · ")[2] + " · 0.0 s");
    expect(out[7]).toBe("related: x, y (add --with-related to install)");
    expect(out).toHaveLength(8);
    // Plain: the dependency lines and the related line carry no warning glyph.
    expect(run.output).not.toContain("⚠");
    expect(run.output.split("\n").find((l) => l.includes("also installs b"))).toBe("also installs b (used by root)");
  });

  it("prints the related line on a single skill that had nothing to install besides", async () => {
    const { f } = registry({ root: {}, x: {} }, { "o/root": [edge("o/x", "see", 1, "o/root")] });
    const flags = flagsFor();
    const out = lines((await runAdd("o/root", flags, depsFor(flags, f))).output);
    expect(out[0]).toMatch(/^✓ root  score \d+/);
    expect(out.at(-1)).toBe("related: x (add --with-related to install)");
  });

  it("prints no related line when there is nothing related", async () => {
    const { f } = registry({ root: {} }, { "o/root": [] });
    const flags = flagsFor();
    expect(stripAnsi((await runAdd("o/root", flags, depsFor(flags, f))).output)).not.toContain("related:");
  });

  it("prints no related line for a run of more than three roots, but --json still has them", async () => {
    const names = ["a", "b", "c", "d"];
    const skills = Object.fromEntries([...names, "x"].map((n) => [n, {}]));
    const closures = Object.fromEntries(names.map((n) => [`o/${n}`, [edge("o/x", "see", 1, `o/${n}`)]]));
    const resolve = async () => names.map((n) => ({ name: n, slug: n, registrySlug: `o/${n}`, source: `registry:o/${n}`, raw: skillMd(n) }));

    const human = flagsFor();
    const { f } = registry(skills, closures);
    const out = stripAnsi((await runAdd("o/a", human, { ...depsFor(human, f), resolve })).output);
    expect(out).not.toContain("related:");

    const js = flagsFor({ json: true });
    const doc = JSON.parse((await runAdd("o/a", js, { ...depsFor(js, f), resolve })).output);
    expect(doc.related).toEqual([{ slug: "o/x", kind: "see", via: "o/a" }]);
  });

  it("keeps --json's alsoInstalled and adds related", async () => {
    const { f } = registry({ root: {}, b: {}, x: {} }, { "o/root": [edge("o/b", "invoke", 1, "o/root"), edge("o/x", "link", 1, "o/root")] });
    const flags = flagsFor({ json: true });
    const doc = JSON.parse((await runAdd("o/root", flags, depsFor(flags, f))).output);
    expect(Object.keys(doc)).toEqual(["ok", "scope", "installed", "blocked", "warnings", "alsoInstalled", "related"]);
    expect(doc.alsoInstalled).toEqual([{ name: "b", usedBy: "root" }]);
    expect(doc.related).toEqual([{ slug: "o/x", kind: "link", via: "o/root" }]);
    expect(doc.installed.map((i: { name: string }) => i.name)).toEqual(["root", "b"]);
  });

  it("leaves --json exactly as it was when there are no dependencies at all", async () => {
    const { f } = registry({ root: {} }, { "o/root": [] });
    const flags = flagsFor({ json: true });
    const doc = JSON.parse((await runAdd("o/root", flags, depsFor(flags, f))).output);
    expect(Object.keys(doc)).toEqual(["ok", "scope", "installed", "blocked", "warnings"]);
  });
});

describe("a plugin run", () => {
  const MEMBERS = (n: number) => Array.from({ length: n }, (_, i) => `member-${String(i).padStart(2, "0")}`);
  /** A plugin of `names`, optionally with extra SKILL.md text per member. */
  function plugin(names: string[], extra: Record<string, string> = {}, more: (r: Req) => Response | undefined = () => undefined) {
    const manifest = { format: 1, slug: "o/p", name: "Test Plugin", download: `${BASE}/api/packs/o/p/download`, members: names.map((n) => ({ slug: `o/${n}`, dir: n, type: "single", verified: false, files: [] })) };
    const zip = zipSync(Object.fromEntries(names.map((n) => [`${n}/SKILL.md`, strToU8(skillMd(n, extra[n] ?? ""))])));
    return fakeFetch((r) => {
      const o = more(r);
      if (o) return o;
      if (r.path.endsWith("/manifest")) return json(manifest);
      if (r.path.endsWith("/download")) return new Response(zip, { status: 200 });
    });
  }

  it("makes no per-member endpoint call when the plugin has many members, and exactly two requests in all", async () => {
    const names = MEMBERS(39);
    const { f, log } = plugin(names);
    const flags = flagsFor();
    const run = await runAdd("plugin:o/p", flags, depsFor(flags, f));
    expect(run.written).toHaveLength(39);
    expect(depRequests(log)).toEqual([]);
    expect(log.map((r) => r.path).sort()).toEqual(["/api/packs/o/p/download", "/api/packs/o/p/manifest"]);
  });

  it("reads the members' own bodies, and asks the registry only about names the plugin lacks", async () => {
    const names = MEMBERS(8);
    // member-00 calls a sibling (in the plugin) and an outsider (not in it).
    const { f, log } = plugin(names, { "member-00": `${POINT("member-05")}\n${POINT("outsider")}` }, (r) => {
      if (r.path === "/api/skills/o/outsider") return json({ slug: "o/outsider", title: "outsider", description: "d", type: "single", source_repo: null, raw_md: skillMd("outsider") });
      if (r.path === "/api/skills/o/outsider/bundle?format=json") return json({ files: [{ path: "SKILL.md", content_base64: b64(skillMd("outsider")), storage: "inline" }] });
    });
    const flags = flagsFor();
    const run = await runAdd("plugin:o/p", flags, depsFor(flags, f));
    expect(run.written.map((w) => w.name)).toContain("outsider");
    expect(depRequests(log)).toEqual([]);
    expect(log.some((r) => r.path === "/api/skills/o/member-05")).toBe(false); // the plugin already holds it
    expect(log.filter((r) => r.path === "/api/skills/o/outsider")).toHaveLength(1);
    expect(lines(run.output)).toContain("also installs outsider (used by member-00)");
  });

  it("asks the endpoint once per root for a run of five or fewer", async () => {
    const names = MEMBERS(5);
    const { f, log } = plugin(names, {}, (r) => (r.path.includes("/deps?") ? json({ deps: [] }) : undefined));
    const flags = flagsFor();
    await runAdd("plugin:o/p", flags, depsFor(flags, f));
    expect(depRequests(log).sort()).toEqual(names.map((n) => `o/${n}`));
  });

  it("asks nothing of the endpoint for a sixth member", async () => {
    const names = MEMBERS(6);
    const { f, log } = plugin(names, {}, (r) => (r.path.includes("/deps?") ? json({ deps: [] }) : undefined));
    const flags = flagsFor();
    await runAdd("plugin:o/p", flags, depsFor(flags, f));
    expect(depRequests(log)).toEqual([]);
  });

  it("brings a --skill selection's endpoint dependencies along", async () => {
    const names = MEMBERS(4);
    const { f } = plugin(names, {}, (r) => {
      if (r.path === "/api/skills/o/member-01/deps?depth=3&kinds=skill_tool,invoke,see,link") return json({ deps: [edge("o/member-03", "invoke", 1, "o/member-01")] });
      // Only member-01 was asked for, so member-03 comes from the registry, not the archive.
      if (r.path === "/api/skills/o/member-03") return json({ slug: "o/member-03", title: "m", description: "d", type: "single", source_repo: null, raw_md: skillMd("member-03") });
      if (r.path === "/api/skills/o/member-03/bundle?format=json") return json({ files: [{ path: "SKILL.md", content_base64: b64(skillMd("member-03")), storage: "inline" }] });
      return r.path.includes("/deps?") ? json({ deps: [] }) : undefined;
    });
    const flags = flagsFor({ skill: ["member-01"] });
    const run = await runAdd("plugin:o/p", flags, depsFor(flags, f));
    expect(run.written.map((w) => w.name).sort()).toEqual(["member-01", "member-03"]);
  });
});

describe("falling back to bodies", () => {
  it("follows a chain to depth three and no deeper", async () => {
    const { f, log } = registry({
      alpha: { extra: POINT("beta") }, beta: { extra: POINT("gamma") }, gamma: { extra: POINT("delta") },
      delta: { extra: POINT("epsilon") }, epsilon: {},
    });
    const flags = flagsFor();
    const run = await runAdd("o/alpha", flags, depsFor(flags, f));
    expect(run.written.map((w) => w.name).sort()).toEqual(["alpha", "beta", "delta", "gamma"]);
    expect(log.some((r) => r.path === "/api/skills/o/epsilon")).toBe(false);
  });

  it("looks only among the same owner's skills", async () => {
    const { f, log } = registry({ root: { extra: 'Call the Skill tool with "other:thing".' } });
    const flags = flagsFor();
    await runAdd("o/root", flags, depsFor(flags, f));
    const looked = log.map((r) => r.path).filter((p) => p.startsWith("/api/skills/") && !p.includes("/deps?") && !p.includes("/bundle"));
    expect(looked.every((p) => p.startsWith("/api/skills/o/"))).toBe(true);
  });

  it("does not follow a see or a link reference when it is reading bodies", async () => {
    const { f } = registry({ root: { extra: "For details see the other skill.\nSee [x](../sibling/SKILL.md)." }, other: {}, sibling: {} });
    const flags = flagsFor();
    const run = await runAdd("o/root", flags, depsFor(flags, f));
    expect(run.written.map((w) => w.name)).toEqual(["root"]);
  });
});
