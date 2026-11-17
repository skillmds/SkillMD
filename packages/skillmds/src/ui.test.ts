import { describe, it, expect } from "vitest";
import { GLYPH, renderCompactRun, renderInstallSummary, shortPath, stripAnsi, table, truncateVisible } from "./ui.js";
import type { CompactSkill } from "./ui.js";

// Written as literal SGR sequences rather than through picocolors: whether pc
// emits colour at all depends on the terminal the suite happens to run in.
const DIM = "\x1b[2m";
const UNDIM = "\x1b[22m";
const RESET = "\x1b[0m";

describe("stripAnsi", () => {
  it("removes SGR sequences and leaves the visible text", () => {
    expect(stripAnsi(`${DIM}abc${UNDIM}`)).toBe("abc");
    expect(stripAnsi("plain")).toBe("plain");
  });
});

describe("truncateVisible", () => {
  it("counts visible characters only and closes any style it left open", () => {
    const out = truncateVisible(`${DIM}abcdefghij${UNDIM}`, 5);
    expect(stripAnsi(out)).toBe("abcd…");
    expect(stripAnsi(out)).toHaveLength(5);
    expect(out.endsWith(RESET)).toBe(true);
  });

  it("leaves a string that already fits exactly as it was", () => {
    expect(truncateVisible(`${DIM}abc${UNDIM}`, 5)).toBe(`${DIM}abc${UNDIM}`);
    expect(truncateVisible("abcde", 5)).toBe("abcde");
  });

  it("adds no reset when the text carried no styling", () => {
    expect(truncateVisible("abcdefghij", 5)).toBe("abcd…");
  });
});

describe("table", () => {
  it("aligns columns and never exceeds the width budget", () => {
    const out = table([["name", "agent", "path"], ["demo", "claude-code", "/very/long/path/that/keeps/going/and/going/and/going"]], { width: 60 });
    for (const line of out.split("\n")) expect(stripAnsi(line).length).toBeLessThanOrEqual(60);
    expect(out).toMatch(/demo\s+claude-code/);
  });

  it("truncates the last column without leaving a dangling escape sequence", () => {
    const out = table([[`${DIM}a${UNDIM}`, `${DIM}${"x".repeat(80)}${UNDIM}`]], { width: 20 });
    expect(stripAnsi(out).length).toBeLessThanOrEqual(20);
    expect(stripAnsi(out).endsWith("…")).toBe(true);
  });
});

describe("shortPath", () => {
  it("replaces the home dir with ~ and the cwd with ./", () => {
    expect(shortPath("/home/u/.claude/skills/x", { home: "/home/u", cwd: "/home/u/proj" })).toBe("~/.claude/skills/x");
    expect(shortPath("/home/u/proj/.agents/skills/x", { home: "/home/u", cwd: "/home/u/proj" })).toBe("./.agents/skills/x");
  });

  it("names the roots themselves without a trailing slash", () => {
    expect(shortPath("/home/u/proj", { home: "/home/u", cwd: "/home/u/proj" })).toBe(".");
    expect(shortPath("/home/u", { home: "/home/u", cwd: "/home/u/proj" })).toBe("~");
  });
});

describe("renderInstallSummary", () => {
  it("lists one row per agent with its mode, then skipped agents dimmed", () => {
    const out = renderInstallSummary({
      name: "demo", score: 92, flags: ["docs_only"], source: "registry:o/demo",
      canonical: "/h/.agents/skills/demo",
      targets: [{ agent: "claude-code", path: "/h/.claude/skills/demo", mode: "junction" }, { agent: "codex", path: "/h/.agents/skills/demo", mode: "canonical" }],
      skipped: [{ agent: "cursor", reason: "not present in this project" }],
    }, { home: "/h", cwd: "/h/p", width: 100 });
    const plain = stripAnsi(out);
    expect(plain).toMatch(/✓ demo\s+score 92\s+docs_only\s+from registry:o\/demo/);
    // The path is the last (truncatable) column, so the short cells never get eaten.
    expect(plain).toMatch(/claude-code\s+junction\s+~\/.claude\/skills\/demo/);
    expect(plain).toMatch(/codex\s+canonical\s+~\/.agents\/skills\/demo/);
    expect(plain).toMatch(/↷ cursor.*not present/);
  });

  it("collapses agents that share one path into a single row", () => {
    const out = renderInstallSummary({ name: "d", score: 90, flags: [], source: "registry:o/d", canonical: "/h/.agents/skills/d",
      targets: [{ agent: "warp", path: "/h/.agents/skills/d", mode: "canonical" }, { agent: "cline", path: "/h/.agents/skills/d", mode: "canonical" }], skipped: [] }, { home: "/h", cwd: "/h/p", width: 100 });
    expect(stripAnsi(out)).toMatch(/warp, cline\s+canonical\s+~\/.agents\/skills\/d/);
  });

  it("keeps every line inside the width budget when the path is very long", () => {
    const out = renderInstallSummary({
      name: "demo", score: 90, flags: [], source: "registry:o/demo",
      canonical: "/h/.agents/skills/demo",
      targets: [{ agent: "claude-code", path: `/h/.claude/${"nested/".repeat(20)}skills/demo`, mode: "junction" }],
      skipped: [],
    }, { home: "/h", cwd: "/h/p", width: 50 });
    for (const line of out.split("\n")) expect(stripAnsi(line).length).toBeLessThanOrEqual(50);
  });

  it("shortens a local: source and keeps the head line inside the width", () => {
    const long = `/h/${"deep/".repeat(20)}demo`;
    const out = renderInstallSummary({
      name: "demo", score: 90, flags: [], source: `local:${long}`, canonical: long,
      targets: [{ agent: "claude-code", path: "/h/.claude/skills/demo", mode: "junction" }],
      skipped: [],
    }, { home: "/h", cwd: "/h/p", width: 50 });
    const head = stripAnsi(out.split("\n")[0]!);
    expect(head).toContain("from local:~/");
    expect(head).not.toContain("/h/deep");
    for (const line of out.split("\n")) expect(stripAnsi(line).length).toBeLessThanOrEqual(50);
  });

  it("marks a replacement with the shared warn glyph", () => {
    const out = renderInstallSummary({
      name: "demo", score: 90, flags: [], source: "registry:o/demo", canonical: "/h/.agents/skills/demo",
      targets: [{ agent: "claude-code", path: "/h/.claude/skills/demo", mode: "junction" }],
      skipped: [], replaced: "untracked",
    }, { home: "/h", cwd: "/h/p", width: 100 });
    expect(stripAnsi(out)).toContain(`${GLYPH.replaced} replaced previous install (untracked directory)`);
    expect(stripAnsi(out).startsWith(`${GLYPH.ok} demo`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A run that installs more than one skill is one header, one line per skill and
// one summary: not a block of per-agent lines for every skill.
// ---------------------------------------------------------------------------
describe("renderCompactRun", () => {
  const AGENTS = ["cursor", "codex", "windsurf", "opencode", "gemini-cli"];
  const target = (agent: string, mode: "junction" | "symlink" | "copy" | "canonical" = "junction") => ({ agent, path: `/h/.${agent}/skills/x`, mode });
  const skill = (name: string, over: Partial<CompactSkill> = {}): CompactSkill => ({
    name, score: 90, flags: [], targets: AGENTS.map((a) => target(a)), skipped: [], ...over,
  });
  const lines = (s: string) => stripAnsi(s).split("\n");
  const run = (over: Partial<Parameters<typeof renderCompactRun>[0]> = {}) => renderCompactRun({
    label: "Mattpocock Skills", agents: AGENTS, installed: [], problems: [], infos: [], elapsedMs: 4234, ...over,
  });

  it("is a header, a line per skill, and one summary naming the agents and the link mode", () => {
    const out = run({ installed: [skill("tdd", { flags: ["docs_only"] }), skill("pr", { score: 85, flags: ["executes_scripts"] }), skill("plain", { score: 100 })] });
    expect(lines(out)).toEqual([
      "Installing Mattpocock Skills, 3 skills, to 5 agents",
      "✓ tdd  score 90  docs_only",
      "✓ pr  score 85  executes_scripts",
      "✓ plain  score 100",
      "3 installed · 5 agents (cursor, codex, windsurf, opencode, gemini-cli) · linked · 4.2 s",
    ]);
  });

  it("never prints the per-agent junction lines", () => {
    const out = stripAnsi(run({ installed: [skill("tdd"), skill("pr")] }));
    expect(out).not.toMatch(/\.cursor\/skills|~\/\.|\bjunction\b/);
  });

  it("gets the singular right", () => {
    const out = lines(run({ agents: ["cursor"], installed: [skill("only", { targets: [target("cursor")] })] }));
    expect(out[0]).toBe("Installing Mattpocock Skills, 1 skill, to 1 agent");
    expect(out.at(-1)).toBe("1 installed · 1 agent (cursor) · linked · 4.2 s");
  });

  it("puts what is about to be pulled in right under the header, as plain text", () => {
    const out = run({ installed: [skill("grill-me"), skill("grilling")], infos: ["also installs grilling (used by grill-me)"] });
    expect(lines(out).slice(0, 3)).toEqual([
      "Installing Mattpocock Skills, 2 skills, to 5 agents",
      "also installs grilling (used by grill-me)",
      "✓ grill-me  score 90",
    ]);
    // No colour and no glyph on that line.
    expect(out.split("\n")[1]).toBe("also installs grilling (used by grill-me)");
  });

  it("collects what went wrong after the skill lines and before the summary", () => {
    const out = run({
      installed: [skill("a"), skill("b")],
      problems: [
        { kind: "failed", name: "triage", reason: "could not fetch agents/openai.yaml: HTTP 429, retry in 2 s" },
        { kind: "warn", text: "o/beta: not in the plugin archive" },
      ],
    });
    expect(lines(out)).toEqual([
      "Installing Mattpocock Skills, 3 skills, to 5 agents",
      "✓ a  score 90",
      "✓ b  score 90",
      "✗ triage  could not fetch agents/openai.yaml: HTTP 429, retry in 2 s",
      "⚠ o/beta: not in the plugin archive",
      "2 installed, 1 failed · 5 agents (cursor, codex, windsurf, opencode, gemini-cli) · linked · 4.2 s",
    ]);
  });

  it("drops the agents from the summary when nothing was installed", () => {
    const out = lines(run({ installed: [], problems: [{ kind: "failed", name: "x", reason: "integrity check failed" }, { kind: "failed", name: "y", reason: "unsafe path" }] }));
    expect(out[0]).toBe("Installing Mattpocock Skills, 2 skills, to 5 agents");
    expect(out.at(-1)).toBe("0 installed, 2 failed · 4.2 s");
  });

  it("says on a skill's own line when it went to different agents than the rest", () => {
    const out = lines(run({ installed: [
      skill("a"), skill("b"), skill("c"),
      skill("odd", { targets: [target("cursor"), target("codex")], skipped: [{ agent: "windsurf", reason: "project-only agent" }] }),
    ] }));
    expect(out).toContain("✓ odd  score 90  agents: cursor, codex; skipped windsurf (project-only agent)");
    expect(out).toContain("✓ a  score 90");
    // The rest of the run is still named once, in the summary.
    expect(out.at(-1)).toMatch(/^4 installed · 5 agents \(cursor, codex, windsurf, opencode, gemini-cli\) · linked/);
  });

  it("says on a skill's own line that it replaced an install", () => {
    const out = lines(run({ installed: [skill("a"), skill("b", { replaced: "github:o/r" }), skill("c", { replaced: "untracked" })] }));
    expect(out).toContain("✓ b  score 90  replaced previous install (github:o/r)");
    expect(out).toContain("✓ c  score 90  replaced previous install (untracked directory)");
  });

  it("names the link mode the run actually used", () => {
    const copied = lines(run({ installed: [skill("a", { targets: AGENTS.map((a) => target(a, "copy")) })] })).at(-1)!;
    expect(copied).toContain(" · copied · ");
    const symlinked = lines(run({ installed: [skill("a", { targets: AGENTS.map((a) => target(a, "symlink")) })] })).at(-1)!;
    expect(symlinked).toContain(" · linked · ");
    const mixed = lines(run({ installed: [skill("a", { targets: [target("cursor"), target("codex", "canonical")] })], agents: ["cursor", "codex"] })).at(-1)!;
    expect(mixed).toBe("1 installed · 2 agents (cursor, codex) · linked + canonical · 4.2 s");
  });

  it("does not list a long run of agents in full", () => {
    const many = Array.from({ length: 12 }, (_, i) => `agent${i}`);
    const out = lines(run({ agents: many, installed: [skill("a", { targets: many.map((a) => target(a)) })] })).at(-1)!;
    expect(out).toBe("1 installed · 12 agents (agent0, agent1, agent2, agent3, agent4, agent5, +6 more) · linked · 4.2 s");
  });

  it("shows seconds to one decimal", () => {
    expect(lines(run({ installed: [skill("a")], elapsedMs: 80 })).at(-1)).toMatch(/ · 0\.1 s$/);
    expect(lines(run({ installed: [skill("a")], elapsedMs: 12_000 })).at(-1)).toMatch(/ · 12\.0 s$/);
  });
});
