import { describe, expect, it } from "vitest";
import { extractSkillRefs, normalizeSkillName, repoKeyOf, resolveRef } from "./deps.js";
import type { DepIndex, DepSource, DepTarget } from "./deps.js";

const names = (body: string) => extractSkillRefs(body).map((r) => `${r.kind}:${r.ns ? r.ns + ":" : ""}${r.name}`);

describe("extractSkillRefs: the Skill tool", () => {
  it("finds the one-line body of a skill that only calls another", () => {
    expect(extractSkillRefs('\nCall the Skill tool with "grilling".\n')).toEqual([
      { name: "grilling", ns: null, kind: "skill_tool", fenced: false, at: 10 },
    ]);
  });
  it("reads Skill(...) call forms and splits a plugin namespace", () => {
    expect(names('Invoke it: Skill(skill: "superpowers:brainstorming")')).toEqual(["skill_tool:superpowers:brainstorming"]);
    expect(names("Use the Skill tool to load `tdd` first.")).toEqual(["skill_tool:tdd"]);
    expect(names("Use the Skill tool, passing 'code-review' as the skill.")).toEqual(["skill_tool:code-review"]);
  });
  it("does not read a quote far from the Skill tool as its argument", () => {
    const far = 'The Skill tool exists. ' + "x".repeat(200) + ' He said "hello".';
    expect(names(far)).toEqual([]);
  });
});

describe("extractSkillRefs: prose, slash and link references", () => {
  it("finds use/invoke/run the X skill", () => {
    expect(names("Then invoke the `pdf-fill` skill to finish.")).toEqual(["invoke:pdf-fill"]);
    expect(names('Run the "release-notes" skill.')).toEqual(["invoke:release-notes"]);
    expect(names("Load the data-viz skill, then continue.")).toEqual(["invoke:data-viz"]);
  });
  it("ignores English where a name should be", () => {
    expect(names("Use this skill when the user asks. Use the following skill for tests. Run a skill. Use the right skill.")).toEqual([]);
    expect(names("Use the same skill again. Apply the relevant skill. Use another skill.")).toEqual([]);
  });
  it("finds see/refer to the X skill", () => {
    expect(names("For details see the api-design skill.")).toEqual(["see:api-design"]);
    expect(names("Refer to the `testing` skill.")).toEqual(["see:testing"]);
  });
  it("finds standalone /slash forms only", () => {
    expect(names("When done, run /review-pr and stop.")).toEqual(["slash:review-pr"]);
    expect(names("Then /ship.")).toEqual(["slash:ship"]);
    expect(names("Open /etc/hosts, src/review/x.ts and https://example.com/review today")).toEqual([]);
    expect(names("Use a/b or and/or like 10/20.")).toEqual([]);
    expect(names("GET /v1/customers/{customer}/subscriptions and /items/[id]/edit and (x)/y")).toEqual([]);
    expect(names("See [the docs](/docs) and the home page.")).toEqual([]);
  });
  it("finds relative links to a sibling skill folder", () => {
    expect(names("See [grilling](../grilling/SKILL.md) first.")).toEqual(["link:grilling"]);
    expect(names("See [x](./references/foo.md) and [y](../other.md).")).toEqual([]);
  });
  it("names the skill folder when the link goes through a category or into its files", () => {
    expect(names("[t](../../operations/threat-modeling/) and [u](../sibling)")).toEqual(["link:threat-modeling", "link:sibling"]);
    expect(names("[a](../x/references/foo.md) [b](../y/SKILL.md#usage) [c](../z/scripts/run.sh)")).toEqual(["link:x", "link:y", "link:z"]);
  });
});

describe("extractSkillRefs: where", () => {
  it("reports the offset of the phrase in the body, frontmatter excluded", () => {
    const raw = '---\nname: a\ndescription: d\n---\nHello there.\nCall the Skill tool with "grilling".';
    const body = raw.slice(raw.indexOf("Hello"));
    const [r] = extractSkillRefs(raw);
    expect(body.slice(r!.at, r!.at + 10)).toBe("Skill tool");
  });
});

describe("extractSkillRefs: scope", () => {
  it("skips the YAML frontmatter, which describes the skill itself", () => {
    const raw = '---\nname: a\ndescription: Use the foo skill when asked.\n---\nHello.';
    expect(names(raw)).toEqual([]);
  });
  it("marks references that sit inside a code fence", () => {
    const raw = 'Write:\n```\nCall the Skill tool with "demo".\n```\nThen call the Skill tool with "real".';
    expect(extractSkillRefs(raw)).toEqual([
      { name: "demo", ns: null, kind: "skill_tool", fenced: true, at: expect.any(Number) },
      { name: "real", ns: null, kind: "skill_tool", fenced: false, at: expect.any(Number) },
    ]);
  });
  it("lists each (ns, name, kind) once, in order of first appearance", () => {
    expect(names('Skill tool with "b". Skill tool with "a". Skill tool with "b". use the b skill.')).toEqual([
      "skill_tool:b",
      "skill_tool:a",
      "invoke:b",
    ]);
  });
  it("normalises names and rejects ones that cannot be a skill name", () => {
    expect(normalizeSkillName("  Grill_Me ")).toBe("grill-me");
    expect(normalizeSkillName("/tdd")).toBe("tdd");
    expect(normalizeSkillName("SKILL.md")).toBe("skill");
    expect(names('Skill tool with "Not A Name!!"')).toEqual([]);
  });
  it("is linear on long hostile input", () => {
    const t = Date.now();
    extractSkillRefs("Skill tool ".repeat(20000) + "use the ".repeat(20000) + "/".repeat(50000));
    expect(Date.now() - t).toBeLessThan(2000);
  });
});

const T = (id: number, owner: string, repo: string | null, dir: string | null = null, repoName: string | null = null): DepTarget => ({ id, owner, repo, dir, repoName });

function indexOf(skills: Record<string, DepTarget[]>): DepIndex {
  const get = (key: string, name: string) => skills[`${key}#${name}`] ?? [];
  return { inRepo: (repo, name) => get(`repo:${repo}`, name), ofOwner: (owner, name) => get(`owner:${owner}`, name) };
}
const src = (over: Partial<DepSource> = {}): DepSource => ({ id: 1, owner: "mattpocock", repo: "github.com/mattpocock/skills", dir: "skills/engineering/grill-me", ...over });
const ref = (name: string, ns: string | null = null) => ({ name, ns, kind: "skill_tool" as const, fenced: false, at: 0 });

describe("resolveRef", () => {
  it("resolves inside the same source repo first", () => {
    const idx = indexOf({
      "repo:github.com/mattpocock/skills#grilling": [T(2, "mattpocock", "github.com/mattpocock/skills")],
      "owner:mattpocock#grilling": [T(9, "mattpocock", "github.com/mattpocock/other")],
    });
    expect(resolveRef(ref("grilling"), src(), idx)).toEqual({ status: "resolved", id: 2, tier: "repo", byPath: false });
  });
  it("falls back to a unique skill of the same owner", () => {
    const idx = indexOf({ "owner:mattpocock#grilling": [T(9, "mattpocock", "github.com/mattpocock/other")] });
    expect(resolveRef(ref("grilling"), src(), idx)).toEqual({ status: "resolved", id: 9, tier: "owner", byPath: false });
  });
  it("never resolves across owners", () => {
    const idx = indexOf({ "owner:someone-else#grilling": [T(7, "someone-else", "github.com/someone-else/x")] });
    expect(resolveRef(ref("grilling"), src(), idx)).toEqual({ status: "unresolved" });
  });
  it("does not resolve a skill to itself", () => {
    const idx = indexOf({ "repo:github.com/mattpocock/skills#grill-me": [T(1, "mattpocock", "github.com/mattpocock/skills")] });
    expect(resolveRef(ref("grill-me"), src(), idx)).toEqual({ status: "unresolved" });
  });
  it("does not resolve a skill's mention of its own name to a same-named twin beside it", () => {
    const idx = indexOf({ "repo:github.com/mattpocock/skills#grill-me": [T(2, "mattpocock", "github.com/mattpocock/skills")] });
    expect(resolveRef(ref("grill-me"), src({ names: ["grill-me", "grill-me-2"] }), idx)).toEqual({ status: "unresolved" });
    expect(resolveRef(ref("grill-me"), src(), idx)).toMatchObject({ status: "resolved", id: 2 });
  });
  it("treats a numbered twin slug as the same skill when it mentions its own un-numbered name", () => {
    const idx = indexOf({ "repo:github.com/mattpocock/skills#kotlin-coroutines": [T(2, "mattpocock", "github.com/mattpocock/skills")] });
    expect(resolveRef(ref("kotlin-coroutines"), src({ names: ["kotlin-coroutines-2"] }), idx)).toEqual({ status: "unresolved" });
    expect(resolveRef(ref("phase"), src({ names: ["phase-2"] }), indexOf({ "repo:github.com/mattpocock/skills#phase": [T(3, "mattpocock", "github.com/mattpocock/skills")] }))).toEqual({ status: "unresolved" });
  });
  it("calls several matches in the repo ambiguous unless one folder is clearly nearest", () => {
    const two = indexOf({
      "repo:github.com/mattpocock/skills#grilling": [
        T(2, "mattpocock", "github.com/mattpocock/skills", "skills/a/grilling"),
        T(3, "mattpocock", "github.com/mattpocock/skills", "skills/b/grilling"),
      ],
    });
    expect(resolveRef(ref("grilling"), src({ dir: "skills/c/grill-me" }), two)).toEqual({ status: "ambiguous", tier: "repo", count: 2 });
    expect(resolveRef(ref("grilling"), src({ dir: "skills/a/grill-me" }), two)).toEqual({ status: "resolved", id: 2, tier: "repo", byPath: true });
  });
  it("takes the lowest id when every candidate is the same body, since they are copies of one skill", () => {
    const twin = (id: number, dir: string): DepTarget => ({ ...T(id, "mattpocock", "github.com/mattpocock/skills", dir), sha: "abc" });
    const idx = indexOf({ "repo:github.com/mattpocock/skills#grilling": [twin(9, "skills/b/grilling"), twin(4, "skills/a/grilling")] });
    expect(resolveRef(ref("grilling"), src({ dir: "skills/c/grill-me" }), idx)).toEqual({ status: "resolved", id: 4, tier: "repo", byPath: false, twin: true });
    const differ = indexOf({
      "repo:github.com/mattpocock/skills#grilling": [{ ...T(9, "mattpocock", "github.com/mattpocock/skills", "skills/b/grilling"), sha: "abc" }, { ...T(4, "mattpocock", "github.com/mattpocock/skills", "skills/a/grilling"), sha: "def" }],
    });
    expect(resolveRef(ref("grilling"), src({ dir: "skills/c/grill-me" }), differ)).toEqual({ status: "ambiguous", tier: "repo", count: 2 });
  });
  it("calls several same-owner matches ambiguous", () => {
    const idx = indexOf({ "owner:mattpocock#x": [T(5, "mattpocock", "github.com/mattpocock/p"), T(6, "mattpocock", "github.com/mattpocock/q")] });
    expect(resolveRef(ref("x"), src(), idx)).toEqual({ status: "ambiguous", tier: "owner", count: 2 });
  });
  it("uses a plugin namespace to choose among repo matches by repo name", () => {
    const idx = indexOf({
      "owner:obra#brainstorming": [T(5, "obra", "github.com/obra/superpowers", null, "superpowers"), T(6, "obra", "github.com/obra/old-fork", null, "old-fork")],
    });
    expect(resolveRef(ref("brainstorming", "superpowers"), src({ owner: "obra", repo: "github.com/obra/zzz", dir: null }), idx)).toEqual({
      status: "resolved",
      id: 5,
      tier: "owner",
      byPath: false,
    });
  });
});

describe("repoKeyOf", () => {
  it("reduces a source_repo URL to host/owner/repo plus the folder under it", () => {
    expect(repoKeyOf("https://github.com/mattpocock/skills/tree/main/skills/engineering/tdd")).toEqual({
      repo: "github.com/mattpocock/skills",
      repoName: "skills",
      dir: "skills/engineering/tdd",
    });
    expect(repoKeyOf("https://github.com/mattpocock/skills")).toEqual({ repo: "github.com/mattpocock/skills", repoName: "skills", dir: null });
    expect(repoKeyOf("https://www.github.com/Foo/Bar.git/")).toEqual({ repo: "github.com/foo/bar", repoName: "bar", dir: null });
    expect(repoKeyOf("not a url")).toEqual({ repo: null, repoName: null, dir: null });
    expect(repoKeyOf(null)).toEqual({ repo: null, repoName: null, dir: null });
  });
});
