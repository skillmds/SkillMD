import { describe, it, expect } from "vitest";
import { expandPointers } from "./alsoInstall.js";
import type { PointerNode } from "./alsoInstall.js";

describe("expandPointers", () => {
  const node = (name: string, points: string[] = [], extra: Partial<PointerNode> = {}): PointerNode => ({
    name, raw: points.map((p) => `Use the ${p} skill.`).join("\n"), ...extra,
  });
  const names = (xs: PointerNode[]) => xs.map((x) => x.name);

  it("adds a pointed skill from the pool, recording who used it", async () => {
    const pool = [node("grill-me", ["grilling"]), node("grilling"), node("unrelated")];
    const out = await expandPointers([pool[0]!], pool);
    expect(names(out)).toEqual(["grill-me", "grilling"]);
    expect(out[0]!.usedBy).toBeUndefined();
    expect(out[1]!.usedBy).toBe("grill-me");
  });

  it("leaves what it was given as it was", async () => {
    const pool = [node("grill-me", ["grilling"]), node("grilling")];
    await expandPointers([pool[0]!], pool);
    expect(pool[1]!.usedBy).toBeUndefined();
  });

  it("reads a pointer in a skill the way the detector does", async () => {
    const pool = [{ name: "grill-me", raw: 'Call the Skill tool with "grilling".' }, node("grilling")];
    expect(names(await expandPointers([pool[0]!], pool))).toEqual(["grill-me", "grilling"]);
  });

  it("finds a member by its directory or its registry name", async () => {
    const pool = [node("alpha", ["beta", "gamma"]), node("beta-dir", [], { slug: "beta" }), node("owner-gamma", [], { registrySlug: "o/gamma" })];
    expect(names(await expandPointers([pool[0]!], pool))).toEqual(["alpha", "beta-dir", "owner-gamma"]);
  });

  it("adds nothing for a pointer to a skill that is not there", async () => {
    const pool = [node("alpha", ["ghost"])];
    expect(names(await expandPointers([pool[0]!], pool))).toEqual(["alpha"]);
  });

  it("does not add a skill that is already in the run", async () => {
    const pool = [node("alpha", ["beta"]), node("beta")];
    const out = await expandPointers(pool, pool);
    expect(names(out)).toEqual(["alpha", "beta"]);
    expect(out.every((x) => x.usedBy === undefined)).toBe(true); // beta was picked, not pulled in
  });

  it("does not add the same skill twice when two skills point at it", async () => {
    const pool = [node("alpha", ["shared"]), node("beta", ["shared"]), node("shared")];
    const out = await expandPointers([pool[0]!, pool[1]!], pool);
    expect(names(out)).toEqual(["alpha", "beta", "shared"]);
    expect(out[2]!.usedBy).toBe("alpha");
  });

  it("survives a cycle and installs each once", async () => {
    const pool = [node("alpha", ["beta"]), node("beta", ["alpha"])];
    expect(names(await expandPointers([pool[0]!], pool))).toEqual(["alpha", "beta"]);
  });

  it("follows a pointer of a pointer once more and no deeper", async () => {
    const pool = [node("alpha", ["beta"]), node("beta", ["gamma"]), node("gamma", ["delta"]), node("delta", ["epsilon"]), node("epsilon")];
    const out = await expandPointers([pool[0]!], pool);
    expect(names(out)).toEqual(["alpha", "beta", "gamma"]);
    expect(out.map((x) => x.usedBy)).toEqual([undefined, "alpha", "beta"]); // the nearest user
  });

  it("asks the fallback only when the pool has no such skill, and takes what it gives", async () => {
    const asked: string[] = [];
    const out = await expandPointers([node("alpha", ["inpool", "remote"])], [node("inpool")], {
      extra: async (name) => { asked.push(name); return node(name); },
    });
    expect(names(out)).toEqual(["alpha", "inpool", "remote"]);
    expect(asked).toEqual(["remote"]);
  });

  it("tells the fallback which skill pointed", async () => {
    let from: string | undefined;
    await expandPointers([node("alpha", ["remote"])], [], { extra: async (name, f) => { from = f.name; return node(name); } });
    expect(from).toBe("alpha");
  });

  it("treats a fallback that fails as a miss", async () => {
    const out = await expandPointers([node("alpha", ["xx", "yy"])], [], {
      extra: async (name) => { if (name === "xx") throw new Error("down"); return node(name); },
    });
    expect(names(out)).toEqual(["alpha", "yy"]);
  });

  it("does not ask the fallback again for a name it already could not find", async () => {
    const asked: string[] = [];
    await expandPointers([node("alpha", ["ghost"]), node("beta", ["ghost"])], [], { extra: async (n) => { asked.push(n); return null; } });
    expect(asked).toEqual(["ghost"]);
  });

  it("never names a skill as its own pointer", async () => {
    const pool = [node("alpha", ["alpha"])];
    expect(names(await expandPointers(pool, pool))).toEqual(["alpha"]);
  });

  it("takes a fallback's answer that is already in the run as a repeat, not a second copy", async () => {
    const out = await expandPointers([node("alpha", ["beta"]), node("beta")], [], { extra: async () => node("beta") });
    expect(names(out)).toEqual(["alpha", "beta"]);
  });
});
