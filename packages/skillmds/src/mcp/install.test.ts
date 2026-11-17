import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFromRegistry } from "./install.js";
import type { ToolContext } from "./tools.js";
import { IntegrityError } from "../api.js";
import { readLock } from "../lock.js";
import { installSkill } from "../installer.js";

const tmps: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "skillmd-mcpi-"));
  tmps.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const RAW = "---\nname: demo\ndescription: A registry skill used to test the MCP installer.\nlicense: MIT\n---\n\n# Demo\n\n" + "Do the thing. ".repeat(30);
const skill = { slug: "o/demo", title: "Demo", description: "d", raw_md: RAW, type: "single", security_flags: ["docs_only"], commit_sha: "abc" };
/** A context over `record`, which collects every API path the installer calls. */
const ctxWith = (home: string, cwd: string, over: Partial<ToolContext> = {}, record: string[] = []): ToolContext => ({
  api: (async (path: string) => {
    record.push(path);
    if (path === "/api/skills/o/demo") return skill;
    if (path.endsWith("/install")) return {};
    throw new Error(`unexpected ${path}`);
  }) as ToolContext["api"],
  hasToken: false,
  base: "https://api.test",
  cwd,
  home,
  env: { DO_NOT_TRACK: "1" },
  ...over,
});
const ctx = (home: string, cwd: string): ToolContext => ctxWith(home, cwd);

const BAD_RAW = "---\nname: demo\n---\nno description";
const pack = { ...skill, type: "pack", source_repo: "https://github.com/o/demo" };
/** A context that serves the pack record instead of the single-file one. */
const packCtx = (home: string, cwd: string, record: string[] = []): ToolContext =>
  ctxWith(
    home,
    cwd,
    {
      api: (async (path: string) => {
        record.push(path);
        if (path === "/api/skills/o/demo") return pack;
        if (path.endsWith("/install")) return {};
        throw new Error(`unexpected ${path}`);
      }) as ToolContext["api"],
    },
    record,
  );

describe("installFromRegistry", () => {
  it("defaults to project scope when the cwd looks like a project, else global", async () => {
    const home = tmp();
    mkdirSync(join(home, ".claude"));
    const cwd = tmp();
    mkdirSync(join(cwd, ".git"));
    mkdirSync(join(cwd, ".claude"));
    const r = await installFromRegistry({ slug: "o/demo" }, ctx(home, cwd));
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ installed: true, scope: "project" });
    expect(existsSync(join(cwd, ".claude", "skills", "demo", "SKILL.md"))).toBe(true);
    expect(readLock({ global: false, cwd }).skills.demo?.source).toBe("registry:o/demo");

    const stray = tmp();
    const g = await installFromRegistry({ slug: "o/demo" }, ctx(home, stray));
    expect(g.structuredContent).toMatchObject({ scope: "global" });
    expect(existsSync(join(stray, ".claude"))).toBe(false);
    expect(existsSync(join(home, ".agents", "skills", "demo", "SKILL.md"))).toBe(true);
  });

  it("honours scope and agents", async () => {
    const home = tmp();
    mkdirSync(join(home, ".claude"));
    mkdirSync(join(home, ".cursor"));
    const r = await installFromRegistry({ slug: "o/demo", scope: "global", agents: ["cursor"] }, ctx(home, tmp()));
    expect((r.structuredContent as { targets: { agent: string }[] }).targets.map((t) => t.agent)).toEqual(["cursor"]);
  });

  it("accepts a legacy dest only when it is a known agent skills dir", async () => {
    const home = tmp();
    mkdirSync(join(home, ".claude"));
    const ok = await installFromRegistry({ slug: "o/demo", dest: join(home, ".claude", "skills") }, ctx(home, tmp()));
    expect(ok.isError).toBeFalsy();
    const bad = await installFromRegistry({ slug: "o/demo", dest: join(home, ".ssh") }, ctx(home, tmp()));
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toMatch(/not a known agent skills directory/);
    expect(existsSync(join(home, ".ssh"))).toBe(false);
  });

  it("a dest of the cross-agent canonical root writes the canonical copy only", async () => {
    const home = tmp();
    mkdirSync(join(home, ".codex"));
    const r = await installFromRegistry({ slug: "o/demo", dest: join(home, ".agents", "skills") }, ctx(home, tmp()));
    expect(r.isError).toBeFalsy();
    expect((r.structuredContent as { targets: unknown[] }).targets).toEqual([]);
    expect(r.content[0]!.text).toMatch(/canonical only/);
    expect(existsSync(join(home, ".agents", "skills", "demo", "SKILL.md"))).toBe(true);
    expect(existsSync(join(home, ".codex"))).toBe(true);
    expect(existsSync(join(home, ".codex", "skills"))).toBe(false);
  });

  it("refuses dest and agents together rather than guessing which one wins", async () => {
    const home = tmp();
    mkdirSync(join(home, ".claude"));
    const r = await installFromRegistry({ slug: "o/demo", dest: join(home, ".claude", "skills"), agents: ["cursor"] }, ctx(home, tmp()));
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/either `dest` or `agents`/);
    expect(existsSync(join(home, ".agents"))).toBe(false);
  });

  it("re-lints the SKILL.md the pack fallback actually writes, and refuses a bad one", async () => {
    const home = tmp();
    const r = await installFromRegistry({ slug: "o/demo", scope: "global" }, packCtx(home, tmp()), {
      fetchBundle: async () => null,
      resolvePackFiles: async () => ({ raw: BAD_RAW, files: [{ path: "SKILL.md", contents: BAD_RAW }], pinMiss: true }),
    });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/failed validation/);
    expect(existsSync(join(home, ".agents"))).toBe(false);
  });

  it("notes an unpinned pack fallback in the install summary", async () => {
    const home = tmp();
    mkdirSync(join(home, ".claude"));
    const r = await installFromRegistry({ slug: "o/demo", scope: "global" }, packCtx(home, tmp()), {
      fetchBundle: async () => null,
      resolvePackFiles: async () => ({
        raw: RAW,
        files: [
          { path: "SKILL.md", contents: RAW },
          { path: "reference.md", contents: "extra" },
        ],
        pinMiss: true,
      }),
    });
    expect(r.isError).toBeFalsy();
    expect((r.structuredContent as { note?: string }).note).toMatch(/pinned commit/);
    expect((r.structuredContent as { files_written: number }).files_written).toBe(2);
    expect(existsSync(join(home, ".agents", "skills", "demo", "reference.md"))).toBe(true);
  });

  it("refuses a pack that fails integrity verification without writing", async () => {
    const home = tmp();
    const r = await installFromRegistry({ slug: "o/demo", scope: "global" }, packCtx(home, tmp()), {
      fetchBundle: async () => {
        throw new IntegrityError("bad");
      },
    });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/integrity/);
    expect(existsSync(join(home, ".agents"))).toBe(false);
  });

  it("counts an install unless telemetry is opted out", async () => {
    const home = tmp();
    mkdirSync(join(home, ".claude"));
    const on: string[] = [];
    await installFromRegistry({ slug: "o/demo", scope: "global" }, ctxWith(home, tmp(), { env: {} }, on));
    expect(on.filter((p) => p.endsWith("/install"))).toEqual(["/api/skills/o/demo/install"]);

    const off: string[] = [];
    await installFromRegistry({ slug: "o/demo", scope: "global", force: true }, ctxWith(home, tmp(), { env: { DO_NOT_TRACK: "1" } }, off));
    expect(off.some((p) => p.endsWith("/install"))).toBe(false);
  });

  it("refuses invalid slugs, denied flags and lint failures without writing", async () => {
    const home = tmp();
    expect((await installFromRegistry({ slug: "../x" }, ctx(home, tmp()))).isError).toBe(true);
    const denied = await installFromRegistry({ slug: "o/demo", scope: "global", deny: ["docs_only"] }, ctx(home, tmp()));
    expect(denied.isError).toBe(true);
    const c = ctx(home, tmp());
    c.api = (async () => ({ ...skill, raw_md: "---\nname: demo\n---\nno description" })) as ToolContext["api"];
    expect((await installFromRegistry({ slug: "o/demo", scope: "global" }, c)).isError).toBe(true);
    expect(existsSync(join(home, ".agents"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Dependencies. skillmd_install does what `add` does: the hard dependencies of
// the skill (skill_tool, invoke) are written too, silently, and reported in the
// result; soft ones (see, link) are only listed as related and come with
// with_related. The same resolver (src/skillDeps.ts) works out which.
// ---------------------------------------------------------------------------
describe("installFromRegistry: dependencies", () => {
  const body = (name: string, extra = "") => `---\nname: ${name}\ndescription: A registry skill called ${name}, used to test the MCP installer.\nlicense: MIT\n---\n\n# ${name}\n\n${extra}\n${"Do the thing. ".repeat(30)}`;
  const POINT = (n: string) => `Call the Skill tool with "${n}".`;
  const edge = (slug: string, kind: string, depth: number, via: string) => ({ slug, kind, depth, via });
  /** A skill already on disk, from somewhere else. */
  const installSkillFixture = (home: string, name: string) =>
    installSkill({ name, files: [{ path: "SKILL.md", contents: body(name) }], source: "github:x/other", scope: { global: true, home }, agents: ["claude-code"], explicitAgents: true });

  interface S { extra?: string; raw?: string; flags?: string[]; repo?: string | null; fail?: number }
  type Closure = ReturnType<typeof edge>[] | { deps: ReturnType<typeof edge>[]; truncated?: boolean } | number | "network";

  /** A context over skills under owner `o`, and a closure (or a failure) per root. Records every path. */
  function world(skills: Record<string, S>, closures: Record<string, Closure> = {}, home = "", cwd = "") {
    const paths: string[] = [];
    const api = (async (path: string) => {
      paths.push(path);
      if (path.endsWith("/install")) return {};
      const d = /^\/api\/skills\/(o\/[^/?]+)\/deps\?/.exec(path);
      if (d) {
        const c = closures[d[1]!];
        if (c === undefined) throw new Error(`SkillMD API 404 on ${path}`);
        if (c === "network") throw new Error("could not reach https://api.test: fetch failed");
        if (typeof c === "number") throw new Error(`SkillMD API ${c} on ${path}`);
        return { slug: d[1], depth: 3, kinds: [], truncated: false, ...(Array.isArray(c) ? { deps: c } : c) };
      }
      const m = /^\/api\/skills\/o\/([^/?]+)$/.exec(path);
      const s = m && skills[m[1]!];
      if (!m || !s) throw new Error(`SkillMD API 404 on ${path}`);
      if (s.fail) throw new Error(`SkillMD API ${s.fail} on ${path}`);
      return {
        slug: `o/${m[1]}`, title: m[1], description: "d", type: "single", raw_md: s.raw ?? body(m[1]!, s.extra),
        security_flags: s.flags ?? ["docs_only"], source_repo: s.repo === undefined ? "o/skills" : s.repo,
      };
    }) as ToolContext["api"];
    const c: ToolContext = { api, hasToken: false, base: "https://api.test", cwd, home, env: { DO_NOT_TRACK: "1" } };
    return { ctx: c, paths };
  }
  const noBundle = { fetchBundle: async () => null };
  const where = (home: string, name: string) => join(home, ".agents", "skills", name, "SKILL.md");
  const deps = (r: { paths: string[] }) => r.paths.filter((p) => p.includes("/deps?"));
  const alsoOf = (r: { structuredContent?: unknown }) => (r.structuredContent as { also_installed?: { slug: string; used_by: string }[] }).also_installed;

  async function run(skills: Record<string, S>, closures: Record<string, Closure>, args: Record<string, unknown> = {}, slug = "o/root") {
    const home = tmp();
    const w = world(skills, closures, home, tmp());
    const r = await installFromRegistry({ slug, scope: "global", agents: ["claude-code"], ...args }, w.ctx, noBundle);
    return { r, home, ...w };
  }

  it("asks the registry for the closure once and installs the hard dependencies it names", async () => {
    // root's body says nothing: only the closure can have found `grilling`.
    const x = await run({ root: {}, grilling: {} }, { "o/root": [edge("o/grilling", "skill_tool", 1, "o/root")] });
    expect(x.r.isError).toBeFalsy();
    expect(existsSync(where(x.home, "root"))).toBe(true);
    expect(existsSync(where(x.home, "grilling"))).toBe(true);
    expect(deps(x)).toEqual(["/api/skills/o/root/deps?depth=3&kinds=skill_tool,invoke,see,link"]);
    expect(alsoOf(x.r)).toEqual([{ slug: "o/grilling", used_by: "o/root" }]);
    expect(x.r.content[0]!.text).toMatch(/also installed.*grilling.*used by o\/root/i);
    expect(readLock({ global: true, home: x.home }).skills.grilling?.source).toBe("registry:o/grilling");
  });

  it("reports the root's own summary exactly as before", async () => {
    const x = await run({ root: {}, grilling: {} }, { "o/root": [edge("o/grilling", "skill_tool", 1, "o/root")] });
    expect(x.r.structuredContent).toMatchObject({ installed: true, slug: "o/root", scope: "global", files_written: 1 });
  });

  it("writes the dependency the way it writes the root: same scope, agents and mode", async () => {
    const x = await run({ root: {}, grilling: {} }, { "o/root": [edge("o/grilling", "invoke", 1, "o/root")] }, { mode: "copy" });
    expect(readLock({ global: true, home: x.home }).skills.grilling?.agents).toEqual(readLock({ global: true, home: x.home }).skills.root?.agents);
    expect(readLock({ global: true, home: x.home }).skills.grilling?.mode).toEqual(readLock({ global: true, home: x.home }).skills.root?.mode);
  });

  for (const [what, closure] of [["404", undefined], ["a 500", 500], ["a 503", 503], ["a network failure", "network"]] as const) {
    it(`reads the body when the closure is unavailable (${what})`, async () => {
      const closures: Record<string, Closure> = closure === undefined ? {} : { "o/root": closure };
      const x = await run({ root: { extra: POINT("grilling") }, grilling: {} }, closures);
      expect(existsSync(where(x.home, "grilling"))).toBe(true);
      expect(alsoOf(x.r)).toEqual([{ slug: "o/grilling", used_by: "o/root" }]);
    });
  }

  it("does not install a hard dependency that hangs off a soft one, and lists both as related", async () => {
    const x = await run({ root: {}, soft: {}, hard: {} }, { "o/root": [edge("o/soft", "see", 1, "o/root"), edge("o/hard", "skill_tool", 2, "o/soft")] });
    expect(existsSync(where(x.home, "soft"))).toBe(false);
    expect(existsSync(where(x.home, "hard"))).toBe(false);
    expect(alsoOf(x.r)).toBeUndefined();
    expect((x.r.structuredContent as { related: unknown }).related).toEqual([
      { slug: "o/soft", kind: "see", via: "o/root" }, { slug: "o/hard", kind: "skill_tool", via: "o/soft" },
    ]);
    expect(x.r.content[0]!.text).toMatch(/related.*soft.*hard.*with_related/i);
  });

  it("installs the related ones as well with with_related", async () => {
    const x = await run({ root: {}, soft: {}, hard: {} }, { "o/root": [edge("o/soft", "see", 1, "o/root"), edge("o/hard", "skill_tool", 2, "o/soft")] }, { with_related: true });
    expect(existsSync(where(x.home, "soft"))).toBe(true);
    expect(existsSync(where(x.home, "hard"))).toBe(true);
    expect(alsoOf(x.r)).toEqual([{ slug: "o/soft", used_by: "o/root" }, { slug: "o/hard", used_by: "o/soft" }]);
    expect((x.r.structuredContent as { related?: unknown }).related).toBeUndefined();
  });

  it("only takes with_related as a real boolean", async () => {
    const x = await run({ root: {}, soft: {} }, { "o/root": [edge("o/soft", "see", 1, "o/root")] }, { with_related: "yes" });
    expect(existsSync(where(x.home, "soft"))).toBe(false);
  });

  it("skips a dependency the registry will not give, saying nothing", async () => {
    const x = await run({ root: {}, other: {} }, { "o/root": [edge("o/private", "invoke", 1, "o/root"), edge("o/other", "invoke", 1, "o/root")] });
    expect(x.r.isError).toBeFalsy();
    expect(alsoOf(x.r)).toEqual([{ slug: "o/other", used_by: "o/root" }]);
    expect(JSON.stringify(x.r)).not.toMatch(/private/);
  });

  it("installs what a truncated closure lists", async () => {
    const x = await run({ root: {}, a: {} }, { "o/root": { deps: [edge("o/a", "invoke", 1, "o/root")], truncated: true } });
    expect(alsoOf(x.r)).toEqual([{ slug: "o/a", used_by: "o/root" }]);
  });

  it("ends a cycle", async () => {
    const x = await run({ a: { extra: POINT("b") }, b: { extra: POINT("a") } }, {}, {}, "o/a");
    expect(alsoOf(x.r)).toEqual([{ slug: "o/b", used_by: "o/a" }]);
  });

  it("follows bodies three deep and no deeper when it has to read them", async () => {
    const x = await run({
      a: { extra: POINT("b") }, b: { extra: POINT("c") }, c: { extra: POINT("d") }, d: { extra: POINT("e") }, e: {},
    }, {}, {}, "o/a");
    expect(alsoOf(x.r)!.map((d) => d.slug)).toEqual(["o/b", "o/c", "o/d"]);
    expect(x.paths).not.toContain("/api/skills/o/e");
  });

  it("looks only under the root's own owner when it reads bodies", async () => {
    const x = await run({ root: { extra: 'Call the Skill tool with "other:thing".' } }, {});
    expect(x.paths.filter((p) => p.startsWith("/api/skills/") && !p.endsWith("/install") && !p.includes("/deps?")).every((p) => p.startsWith("/api/skills/o/"))).toBe(true);
  });

  it("leaves a dependency that is already installed alone, silently", async () => {
    const home = tmp();
    const w = world({ root: {}, dep: {} }, { "o/root": [edge("o/dep", "invoke", 1, "o/root")] }, home, tmp());
    const first = await installFromRegistry({ slug: "o/dep", scope: "global", agents: ["claude-code"], with_related: false }, w.ctx, noBundle);
    expect(first.isError).toBeFalsy();
    const r = await installFromRegistry({ slug: "o/root", scope: "global", agents: ["claude-code"] }, w.ctx, noBundle);
    expect(r.isError).toBeFalsy();
    expect(alsoOf(r)).toBeUndefined();
    expect(JSON.stringify(r)).not.toMatch(/also_blocked/);
  });

  it("reports a dependency that fails validation, and keeps the root installed", async () => {
    const x = await run({ root: {}, bad: { raw: "---\nname: bad\n---\nno description" } }, { "o/root": [edge("o/bad", "invoke", 1, "o/root")] });
    expect(x.r.isError).toBeFalsy();
    expect(existsSync(where(x.home, "root"))).toBe(true);
    expect(existsSync(where(x.home, "bad"))).toBe(false);
    const blocked = (x.r.structuredContent as { also_blocked: { slug: string; reason: string }[] }).also_blocked;
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.slug).toBe("o/bad");
    expect(blocked[0]!.reason).toMatch(/failed validation/);
  });

  it("holds a dependency to the same deny list as the root", async () => {
    const x = await run({ root: {}, risky: { flags: ["network_calls"] } }, { "o/root": [edge("o/risky", "invoke", 1, "o/root")] }, { deny: ["network_calls"] });
    expect(existsSync(where(x.home, "root"))).toBe(true);
    expect(existsSync(where(x.home, "risky"))).toBe(false);
    expect((x.r.structuredContent as { also_blocked: { slug: string }[] }).also_blocked[0]!.slug).toBe("o/risky");
  });

  it("does not take a dependency of the same name from a different source repository when reading bodies", async () => {
    const x = await run({ root: { extra: POINT("grilling"), repo: "o/skills" }, grilling: { repo: "someone-else/other" } }, {});
    expect(existsSync(where(x.home, "grilling"))).toBe(false);
  });

  it("refuses a root that fails its own checks before looking for anything it depends on", async () => {
    const x = await run({ root: { raw: "---\nname: root\n---\nno description" } }, { "o/root": [edge("o/dep", "invoke", 1, "o/root")] });
    expect(x.r.isError).toBe(true);
    expect(deps(x)).toEqual([]);
    expect(existsSync(join(x.home, ".agents"))).toBe(false);
  });

  it("writes nothing for the dependencies when the root cannot be written", async () => {
    const home = tmp();
    const w = world({ root: {}, dep: {} }, { "o/root": [edge("o/dep", "invoke", 1, "o/root")] }, home, tmp());
    // root is already there from a different source, and --force was not given.
    await installSkillFixture(home, "root");
    const r = await installFromRegistry({ slug: "o/root", scope: "global", agents: ["claude-code"] }, w.ctx, noBundle);
    expect(r.isError).toBe(true);
    expect(existsSync(where(home, "dep"))).toBe(false);
  });

  it("counts the installs of the dependencies unless telemetry is opted out", async () => {
    const home = tmp();
    const w = world({ root: {}, dep: {} }, { "o/root": [edge("o/dep", "invoke", 1, "o/root")] }, home, tmp());
    w.ctx.env = {};
    await installFromRegistry({ slug: "o/root", scope: "global", agents: ["claude-code"] }, w.ctx, noBundle);
    expect(w.paths.filter((p) => p.endsWith("/install")).sort()).toEqual(["/api/skills/o/dep/install", "/api/skills/o/root/install"]);
  });

  it("leaves a skill with no dependencies exactly as it was", async () => {
    const x = await run({ root: {} }, { "o/root": [] });
    const sc = x.r.structuredContent as Record<string, unknown>;
    expect(sc.also_installed).toBeUndefined();
    expect(sc.related).toBeUndefined();
    expect(sc.also_blocked).toBeUndefined();
    expect(x.r.content[0]!.text).not.toMatch(/also installed|related/i);
  });
});

describe("skillmd_install's schema", () => {
  it("accepts with_related, a boolean, and still refuses anything it does not know", async () => {
    const { TOOLS } = await import("./tools.js");
    const t = TOOLS.find((x) => x.name === "skillmd_install")!;
    expect((t.inputSchema.properties as Record<string, { type?: string }>).with_related?.type).toBe("boolean");
    expect(t.inputSchema.additionalProperties).toBe(false);
  });

  it("declares what it reports about dependencies, all of it optional", async () => {
    const { TOOLS } = await import("./tools.js");
    const t = TOOLS.find((x) => x.name === "skillmd_install")!;
    const out = t.outputSchema as { properties: Record<string, { type?: string; items?: { required?: string[] } }>; required: string[] };
    expect(out.properties.also_installed?.type).toBe("array");
    expect(out.properties.also_installed?.items?.required).toEqual(["slug", "used_by"]);
    expect(out.properties.related?.items?.required).toEqual(["slug", "kind", "via"]);
    expect(out.properties.also_blocked?.items?.required).toEqual(["slug", "reason"]);
    for (const k of ["also_installed", "related", "also_blocked"]) expect(out.required).not.toContain(k);
  });
});
