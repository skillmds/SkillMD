import { describe, it, expect } from "vitest";
import { skillPointers } from "./pointers.js";

// A pointer skill hands its work to another skill by name: mattpocock/grill-me's
// whole body is `Call the Skill tool with "grilling".` Installing it alone leaves
// an empty shell, and its page should say which skill it runs.
// These vectors are shared with the CLI's copy of the detector (get-skill add).
describe("skillPointers", () => {
  it("finds the skill a body calls through the Skill tool", () => {
    expect(skillPointers('Call the Skill tool with "grilling".')).toEqual(["grilling"]);
    expect(skillPointers("Invoke the Skill tool (skill: `domain-modeling`) first.")).toEqual(["domain-modeling"]);
    expect(skillPointers("# Grill me\n\nCall the Skill tool with ‘grilling’.\n")).toEqual(["grilling"]);
  });

  it("finds a skill invoked or used by name", () => {
    expect(skillPointers("Invoke the tdd skill before you write code.")).toEqual(["tdd"]);
    expect(skillPointers("Use the `codebase-design` skill for the vocabulary.")).toEqual(["codebase-design"]);
    expect(skillPointers('First run the "diagnosing-bugs" skill.')).toEqual(["diagnosing-bugs"]);
    expect(skillPointers("USE THE PDF SKILL to extract the text.")).toEqual(["pdf"]);
  });

  it("keeps the order, drops repeats and caps the list", () => {
    const body = ["Use the a1 skill.", "Use the b2 skill.", "invoke the a1 skill again", "Use the c3 skill.", "Use the d4 skill."].join("\n");
    expect(skillPointers(body)).toEqual(["a1", "b2", "c3"]);
    expect(skillPointers(body, undefined, 4)).toEqual(["a1", "b2", "c3", "d4"]);
  });

  it("never points a skill at itself", () => {
    expect(skillPointers("Use the grill-me skill.", "grill-me")).toEqual([]);
    expect(skillPointers("Use the grill-me skill, then the grilling skill.\nUse the grilling skill.", "mattpocock/grill-me")).toEqual(["grilling"]);
  });

  it("ignores ordinary uses of the word skill", () => {
    const cases = [
      "Use the following skill when the user asks.",
      "Use a skill when one applies.",
      "Use the same skill every time.",
      "Invoke the Skill tool.",
      "This skill helps you write tests; use the skill whenever needed.",
      "You can use this skill to review code.",
      "Practice makes you use the skills you have.",
      "Use the relevant skill.",
      "Call the skill.",
    ];
    for (const c of cases) expect(skillPointers(c), c).toEqual([]);
  });

  it("does not read the frontmatter", () => {
    const raw = "---\nname: x\ndescription: Use the tdd skill when asked.\n---\nBody without a pointer.\n";
    expect(skillPointers(raw)).toEqual([]);
    expect(skillPointers("---\nname: x\n---\nUse the tdd skill.\n")).toEqual(["tdd"]);
    expect(skillPointers("---\r\nname: x\r\n---\r\nUse the tdd skill.\r\n")).toEqual(["tdd"]);
  });

  it("only returns names a skill can have", () => {
    expect(skillPointers("Use the my_skill skill.")).toEqual([]);
    expect(skillPointers("Use the -x skill.")).toEqual([]);
    expect(skillPointers(`Use the ${"a".repeat(80)} skill.`)).toEqual([]);
    expect(skillPointers("")).toEqual([]);
  });

  it("stays linear on adversarial lines", () => {
    const cases: [string, string][] = [
      ["a verb repeated", "use ".repeat(60000)],
      ["the long name", "use the " + "a".repeat(200000)],
      ["many Skill tool openers", "Skill tool ".repeat(30000)],
      ["Skill tool and a long gap", "Skill tool " + "x ".repeat(100000) + '"a"'],
      ["quotes and names", 'invoke "' + 'a-'.repeat(100000)],
    ];
    for (const [name, text] of cases) {
      const t0 = performance.now();
      skillPointers(text);
      const ms = performance.now() - t0;
      expect(ms, `${name}: ${(text.length / 1000) | 0} KB took ${ms.toFixed(0)} ms`).toBeLessThan(1500);
    }
  });
});
