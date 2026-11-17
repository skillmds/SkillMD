import { describe, it, expect } from "vitest";
import { depsPath, expandByBodies, fetchClosure, parseClosure, partitionDeps, resolveDeps } from "./skillDeps.js";
import type { Api, DepEdge, DepNode } from "./skillDeps.js";

const edge = (slug: string, kind: string, depth: number, via: string): DepEdge => ({ slug, kind, depth, via });
const say = (n: string, points: string[] = [], how: "use" | "tool" = "tool") =>
  points.map((p) => (how === "tool" ? `Call the Skill tool with "${p}".` : `Use the ${p} skill.`)).join("\n") || `# ${n}`;
const node = (name: string, points: string[] = [], extra: Partial<DepNode> = {}): DepNode => ({
  name, registrySlug: `o/${name}`, raw: say(name, points), ...extra,
});
const names = (xs: DepNode[]) => xs.map((x) => x.name);

describe("depsPath", () => {
  it("asks for the closure at depth 3 with all four kinds, in one request", () => {
    expect(depsPath("o/grill-me")).toBe("/api/skills/o/grill-me/deps?depth=3&kinds=skill_tool,invoke,see,link");
  });
});

describe("parseClosure", () => {
  const good = { slug: "o/a", depth: 3, kinds: ["skill_tool"], deps: [{ slug: "o/b", kind: "skill_tool", depth: 1, via: "o/a" }], truncated: false };

  it("reads the listed deps and whether the list was cut", () => {
    expect(parseClosure(good, "o/a")).toEqual({ deps: [edge("o/b", "skill_tool", 1, "o/a")], truncated: false });
    expect(parseClosure({ ...good, truncated: true }, "o/a")?.truncated).toBe(true);
  });

  it("treats a missing truncated as not truncated", () => {
    const { truncated: _t, ...rest } = good;
    expect(parseClosure(rest, "o/a")?.truncated).toBe(false);
  });

  it("answers null for anything that is not a closure, so the caller falls back", () => {
    expect(parseClosure(null, "o/a")).toBeNull();
    expect(parseClosure("nope", "o/a")).toBeNull();
    expect(parseClosure({ slug: "o/a" }, "o/a")).toBeNull();
    expect(parseClosure({ deps: "x" }, "o/a")).toBeNull();
  });

  it("drops entries it cannot trust: a malformed slug, a missing kind or via, a path trick", () => {
    const body = { deps: [
      { slug: "o/ok", kind: "invoke", depth: 1, via: "o/a" },
      { slug: "../etc", kind: "invoke", depth: 1, via: "o/a" },
      { slug: "o/a/b", kind: "invoke", depth: 1, via: "o/a" },
      { slug: "o/nokind", depth: 1, via: "o/a" },
      { slug: "o/novia", kind: "invoke", depth: 1 },
      "x",
      null,
    ] };
    expect(parseClosure(body, "o/a")?.deps.map((d) => d.slug)).toEqual(["o/ok"]);
  });

  it("never lists the root among its own deps", () => {
    const body = { deps: [{ slug: "O/A", kind: "invoke", depth: 1, via: "o/a" }, { slug: "o/b", kind: "invoke", depth: 1, via: "o/a" }] };
    expect(parseClosure(body, "o/a")?.deps.map((d) => d.slug)).toEqual(["o/b"]);
  });
});

describe("partitionDeps", () => {
  it("installs hard deps that hang off the root and lists soft ones as related", () => {
    const { auto, related } = partitionDeps("o/root", [
      edge("o/a", "skill_tool", 1, "o/root"), edge("o/b", "invoke", 1, "o/root"),
      edge("o/c", "see", 1, "o/root"), edge("o/d", "link", 1, "o/root"),
    ]);
    expect(auto.map((e) => e.slug)).toEqual(["o/a", "o/b"]);
    expect(related.map((e) => e.slug)).toEqual(["o/c", "o/d"]);
  });

  it("follows a chain of hard edges", () => {
    const { auto } = partitionDeps("o/root", [edge("o/a", "invoke", 1, "o/root"), edge("o/b", "skill_tool", 2, "o/a"), edge("o/c", "invoke", 3, "o/b")]);
    expect(auto.map((e) => e.slug)).toEqual(["o/a", "o/b", "o/c"]);
  });

  it("does not install a hard edge that hangs off a soft parent", () => {
    const { auto, related } = partitionDeps("o/root", [
      edge("o/soft", "see", 1, "o/root"), edge("o/hard", "skill_tool", 2, "o/soft"), edge("o/deeper", "invoke", 3, "o/hard"),
    ]);
    expect(auto).toEqual([]);
    expect(related.map((e) => e.slug)).toEqual(["o/soft", "o/hard", "o/deeper"]);
  });

  it("reads the slugs without regard to case", () => {
    const { auto } = partitionDeps("o/Root", [edge("o/a", "invoke", 1, "O/ROOT")]);
    expect(auto).toHaveLength(1);
  });

  it("sorts by depth, so a child listed before its parent is still accepted", () => {
    const { auto } = partitionDeps("o/root", [edge("o/b", "invoke", 2, "o/a"), edge("o/a", "invoke", 1, "o/root")]);
    expect(auto.map((e) => e.slug)).toEqual(["o/a", "o/b"]);
  });
});

describe("fetchClosure", () => {
  it("makes one request and returns what came back", async () => {
    const calls: string[] = [];
    const api = (async (p: string) => { calls.push(p); return { deps: [{ slug: "o/b", kind: "invoke", depth: 1, via: "o/a" }], truncated: false }; }) as unknown as Api;
    const c = await fetchClosure(api, "o/a");
    expect(calls).toEqual(["/api/skills/o/a/deps?depth=3&kinds=skill_tool,invoke,see,link"]);
    expect(c?.deps).toHaveLength(1);
  });

  it("answers null for any failure at all", async () => {
    for (const err of [new Error("SkillMD API 404"), new Error("SkillMD API 503"), new TypeError("fetch failed")]) {
      const api = (async () => { throw err; }) as unknown as Api;
      expect(await fetchClosure(api, "o/a")).toBeNull();
    }
    const odd = (async () => ({ nope: 1 })) as unknown as Api;
    expect(await fetchClosure(odd, "o/a")).toBeNull();
  });
});

describe("resolveDeps through the endpoint", () => {
  /** An api that serves a closure per root slug, and counts its calls. */
  function serve(closures: Record<string, { deps: DepEdge[]; truncated?: boolean } | Error>) {
    const calls: string[] = [];
    const api = (async (p: string) => {
      const m = /^\/api\/skills\/(.+)\/deps\?/.exec(p)!;
      calls.push(m[1]!);
      const c = closures[m[1]!];
      if (!c) throw new Error("SkillMD API 404");
      if (c instanceof Error) throw c;
      return { slug: m[1], depth: 3, kinds: [], deps: c.deps, truncated: Boolean(c.truncated) };
    }) as unknown as Api;
    return { api, calls };
  }
  const lookupFrom = (known: string[], asked: string[] = []) => async (slug: string): Promise<DepNode | null> => {
    asked.push(slug);
    const name = slug.split("/")[1]!;
    return known.includes(slug) ? node(name) : null;
  };

  it("asks the endpoint once, and installs the hard deps with who used them", async () => {
    const { api, calls } = serve({ "o/grill-me": { deps: [edge("o/grilling", "skill_tool", 1, "o/grill-me")] } });
    const root = node("grill-me", ["grilling"]);
    const r = await resolveDeps([root], [root], { api, lookup: lookupFrom(["o/grilling"]) });
    expect(calls).toEqual(["o/grill-me"]);
    expect(names(r.pulled)).toEqual(["grilling"]);
    expect(r.pulled[0]!.usedBy).toBe("grill-me");
    expect(r.related).toEqual([]);
    expect(r.truncated).toBe(false);
  });

  it("reads the dep's own via for who used it", async () => {
    const { api } = serve({ "o/a": { deps: [edge("o/b", "invoke", 1, "o/a"), edge("o/c", "invoke", 2, "o/b")] } });
    const root = node("a");
    const r = await resolveDeps([root], [root], { api, lookup: lookupFrom(["o/b", "o/c"]) });
    expect(r.pulled.map((p) => [p.name, p.usedBy])).toEqual([["b", "a"], ["c", "b"]]);
  });

  it("lists soft deps as related and does not install them", async () => {
    const { api } = serve({ "o/a": { deps: [edge("o/b", "invoke", 1, "o/a"), edge("o/c", "see", 1, "o/a"), edge("o/d", "link", 1, "o/a")] } });
    const root = node("a");
    const asked: string[] = [];
    const r = await resolveDeps([root], [root], { api, lookup: lookupFrom(["o/b", "o/c", "o/d"], asked) });
    expect(names(r.pulled)).toEqual(["b"]);
    expect(r.related).toEqual([edge("o/c", "see", 1, "o/a"), edge("o/d", "link", 1, "o/a")]);
    expect(asked).toEqual(["o/b"]); // the related ones were not even looked up
  });

  it("does not install a hard dep that hangs off a soft one", async () => {
    const { api } = serve({ "o/a": { deps: [edge("o/soft", "see", 1, "o/a"), edge("o/hard", "skill_tool", 2, "o/soft")] } });
    const root = node("a");
    const r = await resolveDeps([root], [root], { api, lookup: lookupFrom(["o/soft", "o/hard"]) });
    expect(r.pulled).toEqual([]);
    expect(r.related.map((e) => e.slug)).toEqual(["o/soft", "o/hard"]);
  });

  it("installs everything with withRelated, soft ones included", async () => {
    const { api } = serve({ "o/a": { deps: [edge("o/b", "invoke", 1, "o/a"), edge("o/c", "see", 1, "o/a"), edge("o/d", "skill_tool", 2, "o/c")] } });
    const root = node("a");
    const r = await resolveDeps([root], [root], { api, lookup: lookupFrom(["o/b", "o/c", "o/d"]) }, { withRelated: true });
    expect(names(r.pulled)).toEqual(["b", "c", "d"]);
    expect(r.related).toEqual([]);
  });

  it("skips a dep the registry will not give (not public), without a word", async () => {
    const { api } = serve({ "o/a": { deps: [edge("o/private", "invoke", 1, "o/a"), edge("o/b", "invoke", 1, "o/a")] } });
    const root = node("a");
    const r = await resolveDeps([root], [root], { api, lookup: lookupFrom(["o/b"]) });
    expect(names(r.pulled)).toEqual(["b"]);
  });

  it("never lists the root, or something already in the run, as a dep of its own", async () => {
    const { api } = serve({ "o/a": { deps: [edge("o/a", "invoke", 1, "o/a"), edge("o/b", "invoke", 1, "o/a"), edge("o/a", "invoke", 2, "o/b")] } });
    const a = node("a"); const b = node("b");
    const r = await resolveDeps([a], [a, b], { api, lookup: lookupFrom(["o/a", "o/b"]) }, { inRun: [a, b] });
    expect(r.pulled).toEqual([]); // b was already going in
  });

  it("takes a dep from the pool (the same plugin) before the registry", async () => {
    const { api } = serve({ "o/a": { deps: [edge("o/b", "invoke", 1, "o/a")] } });
    const a = node("a"); const b = node("b", [], { raw: "the plugin's own copy" });
    const asked: string[] = [];
    const r = await resolveDeps([a], [a, b], { api, lookup: lookupFrom(["o/b"], asked) });
    expect(r.pulled).toHaveLength(1);
    expect(r.pulled[0]!.raw).toBe("the plugin's own copy");
    expect(asked).toEqual([]);
  });

  it("does not take a pool member of the same name from another owner", async () => {
    const { api } = serve({ "o/a": { deps: [edge("o/b", "invoke", 1, "o/a")] } });
    const a = node("a"); const other = node("b", [], { registrySlug: "someone/b" });
    const asked: string[] = [];
    const r = await resolveDeps([a], [a, other], { api, lookup: lookupFrom(["o/b"], asked) });
    expect(asked).toEqual(["o/b"]);
    expect(r.pulled[0]!.registrySlug).toBe("o/b");
  });

  it("installs what a truncated list names and says it was cut", async () => {
    const { api } = serve({ "o/a": { deps: [edge("o/b", "invoke", 1, "o/a")], truncated: true } });
    const root = node("a");
    const r = await resolveDeps([root], [root], { api, lookup: lookupFrom(["o/b"]) });
    expect(names(r.pulled)).toEqual(["b"]);
    expect(r.truncated).toBe(true);
  });

  it("makes one request per root, for up to five roots", async () => {
    const roots = ["a", "b", "c", "d", "e"].map((n) => node(n));
    const { api, calls } = serve(Object.fromEntries(roots.map((r) => [r.registrySlug!, { deps: [] }])));
    await resolveDeps(roots, roots, { api, lookup: lookupFrom([]) });
    expect(calls).toEqual(["o/a", "o/b", "o/c", "o/d", "o/e"]);
  });

  it("makes no endpoint request at all for a run of more than five roots", async () => {
    const roots = ["a", "b", "c", "d", "e", "f"].map((n) => node(n));
    const { api, calls } = serve({});
    await resolveDeps(roots, roots, { api, lookup: lookupFrom([]) });
    expect(calls).toEqual([]);
  });

  it("never asks the endpoint about a dependency, the closure already covers the depth", async () => {
    const { api, calls } = serve({ "o/a": { deps: [edge("o/b", "invoke", 1, "o/a"), edge("o/c", "invoke", 2, "o/b")] } });
    const root = node("a");
    await resolveDeps([root], [root], { api, lookup: lookupFrom(["o/b", "o/c"]) });
    expect(calls).toEqual(["o/a"]);
  });

  it("falls back to the body of a root whose request failed, and only that root", async () => {
    const { api, calls } = serve({ "o/a": new Error("SkillMD API 503"), "o/b": { deps: [edge("o/y", "invoke", 1, "o/b")] } });
    const a = node("a", ["x"]); const b = node("b");
    const r = await resolveDeps([a, b], [a, b], { api, lookup: lookupFrom(["o/x", "o/y"]) });
    expect(calls).toEqual(["o/a", "o/b"]);
    expect(r.pulled.map((p) => [p.name, p.usedBy])).toEqual([["x", "a"], ["y", "b"]]);
  });

  it("works without an endpoint at all", async () => {
    const root = node("a", ["x"]);
    const r = await resolveDeps([root], [root], { lookup: lookupFrom(["o/x"]) });
    expect(names(r.pulled)).toEqual(["x"]);
  });
});

describe("expandByBodies (the fallback)", () => {
  const owned = (known: string[], asked: string[] = []) => async (slug: string): Promise<DepNode | null> => {
    asked.push(slug);
    return known.includes(slug) ? node(slug.split("/")[1]!) : null;
  };

  it("follows the Skill tool and 'use the X skill', and nothing softer", async () => {
    const root = node("a");
    root.raw = 'Call the Skill tool with "tool-one".\nUse the prose-one skill.\nFor details see the see-one skill.\nThen run /slash-one.\nSee [l](../link-one/SKILL.md).';
    const asked: string[] = [];
    const out = await expandByBodies([root], [], owned(["o/tool-one", "o/prose-one", "o/see-one", "o/slash-one", "o/link-one"], asked));
    expect(names(out)).toEqual(["a", "tool-one", "prose-one"]);
    expect(asked).toEqual(["o/tool-one", "o/prose-one"]);
  });

  it("reads references inside code fences too", async () => {
    const root = node("a");
    root.raw = 'Example:\n```\nCall the Skill tool with "fenced".\n```\n';
    expect(names(await expandByBodies([root], [], owned(["o/fenced"])))).toEqual(["a", "fenced"]);
  });

  it("reads the forms the old detector did", async () => {
    const cases: [string, string][] = [
      ["Invoke the Skill tool (skill: `domain-modeling`) first.", "domain-modeling"],
      ['First run the "diagnosing-bugs" skill.', "diagnosing-bugs"],
      ["USE THE PDF SKILL to extract the text.", "pdf"],
      ["Invoke the tdd skill before you write code.", "tdd"],
      ['Call the Skill tool with "superpowers:brainstorming".', "brainstorming"],
    ];
    for (const [text, want] of cases) {
      const root = node("a"); root.raw = text;
      expect(names(await expandByBodies([root], [], owned([`o/${want}`]))), text).toEqual(["a", want]);
    }
  });

  it("ignores ordinary uses of the word skill", async () => {
    const root = node("a");
    root.raw = "Use the following skill when the user asks. Use this skill to review code. Use the relevant skill.";
    expect(names(await expandByBodies([root], [], owned([])))).toEqual(["a"]);
  });

  it("never follows a skill to itself", async () => {
    const root = node("a"); root.raw = "Use the a skill.";
    const asked: string[] = [];
    await expandByBodies([root], [], owned(["o/a"], asked));
    expect(asked).toEqual([]);
  });

  it("looks in the pool first, then the same owner, never another", async () => {
    const root = node("a", [], { registrySlug: "mine/a" });
    root.raw = 'Call the Skill tool with "inpool".\nCall the Skill tool with "remote".';
    const asked: string[] = [];
    const out = await expandByBodies([root], [node("inpool", [], { registrySlug: "mine/inpool" })], async (slug) => { asked.push(slug); return node("remote", [], { registrySlug: slug }); });
    expect(names(out)).toEqual(["a", "inpool", "remote"]);
    expect(asked).toEqual(["mine/remote"]); // the root's own owner
  });

  it("does not look in the registry for a root that did not come from it", async () => {
    const root: DepNode = { name: "a", raw: 'Call the Skill tool with "remote".' };
    const asked: string[] = [];
    const out = await expandByBodies([root], [], async (slug) => { asked.push(slug); return null; });
    expect(asked).toEqual([]);
    expect(names(out)).toEqual(["a"]);
  });

  it("ends a cycle and installs each skill once", async () => {
    const a = node("a", ["b"]); const b = node("b", ["a"]);
    const out = await expandByBodies([a], [a, b], async () => null);
    expect(names(out)).toEqual(["a", "b"]);
  });

  it("follows a chain to depth three and no deeper", async () => {
    const chain = ["a", "b", "c", "d", "e", "f"].map((n, i, all) => node(n, all[i + 1] ? [all[i + 1]!] : []));
    const out = await expandByBodies([chain[0]!], chain, async () => null);
    expect(names(out)).toEqual(["a", "b", "c", "d"]);
    expect(out.map((x) => x.usedBy)).toEqual([undefined, "a", "b", "c"]);
  });

  it("asks the registry once for a name however many skills use it, and remembers a miss", async () => {
    const a = node("a", ["ghost"]); const b = node("b", ["ghost"]);
    const asked: string[] = [];
    await expandByBodies([a, b], [a, b], async (slug) => { asked.push(slug); return null; });
    expect(asked).toEqual(["o/ghost"]);
  });

  it("does not look in the registry for a name the pool already holds", async () => {
    const roots = ["a", "b", "c"].map((n) => node(n, ["shared"]));
    const shared = node("shared");
    const asked: string[] = [];
    const out = await expandByBodies(roots, [...roots, shared], async (s) => { asked.push(s); return null; });
    expect(asked).toEqual([]);
    expect(names(out)).toEqual(["a", "b", "c", "shared"]);
  });

  it("does not pull a skill that is already part of the run", async () => {
    const pool = [node("a", ["b"]), node("b")];
    const out = await expandByBodies(pool, pool, async () => null);
    expect(names(out)).toEqual(["a", "b"]);
    expect(out.every((x) => x.usedBy === undefined)).toBe(true);
  });

  it("takes a lookup that throws as a miss", async () => {
    const a = node("a", ["x", "y"]);
    const out = await expandByBodies([a], [], async (s) => { if (s.endsWith("/x")) throw new Error("down"); return node("y"); });
    expect(names(out)).toEqual(["a", "y"]);
  });

  it("follows nothing out of a skill that could not be had", async () => {
    const a = node("a", ["b"], { unavailable: "could not fetch x" }); const b = node("b");
    expect(names(await expandByBodies([a], [a, b], async () => null))).toEqual(["a"]);
  });

  it("never mutates what it was given", async () => {
    const a = node("a", ["b"]); const b = node("b");
    await expandByBodies([a], [a, b], async () => null);
    expect(b.usedBy).toBeUndefined();
  });
});
