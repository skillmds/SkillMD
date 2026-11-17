// Pointer skills. Some skills hand their work to another skill by name:
// mattpocock/grill-me's whole body is `Call the Skill tool with "grilling".`.
// Installing it alone leaves an empty shell, and its page should say which skill
// it runs. This finds those names in a SKILL.md; the caller decides whether a
// skill of that name exists (same owner / same source repo) and acts on it.
//
// What counts, one name per match, on a single line:
//   - the Skill tool named with a quoted name   Call the Skill tool with "grilling"
//   - invoke / use / call / run / load / launch / activate [the] <name> skill
//       Invoke the tdd skill       Use the `codebase-design` skill
// A name is lowercase letters, digits and hyphens (1 to 63 characters), as in
// the Agent Skills format. Ordinary prose that only contains the word "skill"
// ("use the following skill", "use this skill") is not a pointer. The
// frontmatter is not read. Every gap is bounded, so a scan is linear.
//
// The CLI (get-skill add) carries the same detector and the same test vectors
// (packages/core/src/pointers.test.ts); keep the two in step.

const NAME = "[A-Za-z0-9][A-Za-z0-9-]{0,62}";
const OPEN = "[\"'`“‘]";
const CLOSE = "[\"'`”’]";

/** Words that follow "use the" / "invoke the" before "skill" without naming one. */
const NOT_A_NAME = new Set([
  "the", "a", "an", "this", "that", "these", "those", "same", "other", "another", "following", "above", "below",
  "next", "previous", "first", "second", "last", "each", "any", "every", "your", "my", "our", "their", "its",
  "right", "relevant", "appropriate", "matching", "correct", "new", "existing", "given", "specified",
  "corresponding", "specific", "proper", "suitable", "skill", "skills", "tool", "one", "it",
]);

const FRONTMATTER = /^﻿?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

/** The skill names a SKILL.md body points at, in order of appearance, without repeats or `self`, at most `max`. */
export function skillPointers(raw: string, self?: string, max = 3): string[] {
  const body = String(raw ?? "").replace(FRONTMATTER, "");
  const me = self ? self.toLowerCase().split("/").pop() : undefined;
  const found: { at: number; name: string }[] = [];

  const viaTool = new RegExp(String.raw`\bSkill[ \t]+tool\b[^\n]{0,60}?${OPEN}(${NAME})${CLOSE}`, "gi");
  const byName = new RegExp(
    String.raw`\b(?:invoke|use|call|run|load|launch|activate)[ \t]+(?:the[ \t]+)?${OPEN}?(${NAME})${CLOSE}?[ \t]+skill\b`,
    "gi",
  );
  for (const re of [viaTool, byName]) {
    for (const m of body.matchAll(re)) found.push({ at: m.index ?? 0, name: m[1]!.toLowerCase() });
  }
  found.sort((a, b) => a.at - b.at);

  const out: string[] = [];
  for (const { name } of found) {
    if (NOT_A_NAME.has(name) || name === me || name.endsWith("-") || out.includes(name)) continue;
    out.push(name);
    if (out.length >= max) break;
  }
  return out;
}
