// Skill-to-skill dependencies: which other skills does a SKILL.md body call, and
// which concrete catalogue entry does each call mean.
//
// Pure functions only. The API computes a skill's deps from them when a skill is
// saved (next to its security flags), the offline measurement runs the very same
// code over a snapshot, and the CLI/MCP only ever see the resolved result.
//
// Two stages, kept apart on purpose:
//   extractSkillRefs  text -> what the body *says* (a name, how it was said)
//   resolveRef        name -> one skill id, or "ambiguous", or "unresolved"
//
// Resolution never leaves the author's own namespace: same source repo first,
// then the same owner. A reference to a name that only some unrelated account
// publishes is left unresolved rather than guessed, because installing a stranger's
// skill on the strength of a common word ("review", "plan") is the failure to avoid.

export type DepKind = "skill_tool" | "invoke" | "slash" | "see" | "link";

export interface SkillRef {
  /** Lower-case, dash-joined skill name as the body spells it. */
  name: string;
  /** Plugin namespace of a `plugin:skill` reference, else null. */
  ns: string | null;
  kind: DepKind;
  /** The reference sits inside a fenced code block (an example, often not a call). */
  fenced: boolean;
  /** Offset of the phrase in the body with its frontmatter removed (to show why). */
  at: number;
}

const NAME_OK = /^[a-z0-9][a-z0-9.-]{0,63}$/;

/** Canonical spelling used to compare names: lower case, `_`/space become `-`, no
 *  leading slash, no `.md`. */
export function normalizeSkillName(s: string): string {
  return String(s)
    .trim()
    .replace(/^\/+/, "")
    .replace(/\.md$/i, "")
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
}

// Words that stand where a name would in "use the ___ skill" but are English.
const NOT_NAMES = new Set(
  (
    "the a an this that these those another other any each every your my our its their same following " +
    "relevant appropriate right correct matching new existing installed available corresponding specific " +
    "said such one no all both either neither next previous first last proper suitable required needed " +
    "given chosen selected target current skill skills of for to and or it which what whichever"
  ).split(" "),
);

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

/** Splits "ns:name" and validates both halves; null when it cannot be a skill name.
 *  Only prose ("use the ___ skill") is held against the English-word list: a quoted
 *  Skill-tool argument, a /slash or a link target is explicit, and a skill may be
 *  called "new" or "next". */
function toRef(raw: string, kind: DepKind): Pick<SkillRef, "name" | "ns" | "kind"> | null {
  const cut = raw.indexOf(":");
  const nsRaw = cut > 0 ? raw.slice(0, cut) : null;
  const nameRaw = cut > 0 ? raw.slice(cut + 1) : raw;
  const name = normalizeSkillName(nameRaw);
  const ns = nsRaw === null ? null : normalizeSkillName(nsRaw);
  const prose = kind === "invoke" || kind === "see";
  if (!NAME_OK.test(name) || !/[a-z]/.test(name) || (prose && NOT_NAMES.has(name))) return null;
  if (ns !== null && (!NAME_OK.test(ns) || !/[a-z]/.test(ns))) return null;
  return { name, ns, kind };
}

/** [start, end) offsets of every fenced code block, for the `fenced` flag. */
function fenceRanges(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let open = -1;
  let pos = 0;
  for (const line of text.split("\n")) {
    if (/^ {0,3}(```|~~~)/.test(line)) {
      if (open < 0) open = pos;
      else {
        out.push([open, pos + line.length]);
        open = -1;
      }
    }
    pos += line.length + 1;
  }
  if (open >= 0) out.push([open, text.length]);
  return out;
}

const isFenced = (ranges: Array<[number, number]>, at: number): boolean => {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [s, e] = ranges[mid]!;
    if (at < s) hi = mid - 1;
    else if (at > e) lo = mid + 1;
    else return true;
  }
  return false;
};

// "Skill tool" / "Skill(" then a quoted name within a short window.
const SKILL_TOOL = /\bSkill(?:\s+tool\b|\()/gi;
const QUOTED_NEAR = /^[^"'`\n]{0,60}?["'`]([^"'`\s]{1,64})["'`]/;

// "<verb> [the] [`]name[`] skill"
const WORD = "[`\"']?([A-Za-z0-9][\\w:.-]{0,63})[`\"']?";
const INVOKE = new RegExp(
  `\\b(?:use|using|invoke|invoking|run|running|call|calling|load|loading|activate|apply|trigger|launch|follow|consult)\\s+(?:(?:the|our)\\s+)?${WORD}\\s+skill\\b`,
  "gi",
);
const SEE = new RegExp(`\\b(?:see|refer to|defer to|per|check|read)\\s+(?:(?:the|our)\\s+)?${WORD}\\s+skill\\b`, "gi");

// A standalone /name or /plugin:name: not part of a path (also after } or ]), URL, tag,
// word or markdown link target.
const SLASH = /(?<![\w/.:~$@%#&=?+<}\])-])(?<!\]\()\/([a-z][a-z0-9]*(?:[-_:][a-z0-9]+)*)(?![\w/-]|\.\w|:\w)/gi;

// ](../path) out of this skill's folder, or a bare skills/name/SKILL.md path.
const LINK_UP = /\]\(\s*<?(?:\.\.\/)+([^)\s>]+)>?\s*\)/g;
const COMPANION_DIRS = new Set(["references", "reference", "scripts", "assets", "resources", "examples", "templates", "agents", "evals"]);

/** The skill folder a relative link points into: the one before SKILL.md or before a
 *  companion folder (references/, scripts/...), else the last folder of a path that
 *  ends in "/", else null (a bare file such as ../other.md is not a skill). */
function linkSkillName(path: string): string | null {
  const segs = path.split(/[?#]/)[0]!.split("/").filter(Boolean);
  const skillMd = segs.findIndex((x) => x.toLowerCase() === "skill.md");
  if (skillMd > 0) return segs[skillMd - 1]!;
  const comp = segs.findIndex((x) => COMPANION_DIRS.has(x.toLowerCase()));
  if (comp > 0) return segs[comp - 1]!;
  const last = segs[segs.length - 1];
  if (!last || (/\.[A-Za-z0-9]+$/.test(last) && segs.length < 2)) return null;
  if (/\.[A-Za-z0-9]+$/.test(last)) return segs[segs.length - 2]!;
  return last;
}
const LINK_SKILLS = /(?<![\w/.-])skills\/([A-Za-z0-9][\w.-]*)\/SKILL\.md\b/g;

/** Every skill the body (not its frontmatter) refers to, once per (kind, ns, name),
 *  in order of first appearance. Says nothing about whether the name exists. */
export function extractSkillRefs(raw: string): SkillRef[] {
  const fm = FRONTMATTER.exec(raw);
  const text = fm ? raw.slice(fm[0].length) : raw;
  const ranges = fenceRanges(text);
  const hits: Array<{ at: number; ref: Pick<SkillRef, "name" | "ns" | "kind"> }> = [];
  const add = (at: number, token: string, kind: DepKind) => {
    const ref = toRef(token, kind);
    if (ref) hits.push({ at, ref });
  };

  for (const m of text.matchAll(SKILL_TOOL)) {
    const from = m.index! + m[0].length;
    const near = QUOTED_NEAR.exec(text.slice(from, from + 90));
    if (near) add(m.index!, near[1]!, "skill_tool");
  }
  for (const m of text.matchAll(INVOKE)) add(m.index!, m[1]!, "invoke");
  for (const m of text.matchAll(SEE)) add(m.index!, m[1]!, "see");
  for (const m of text.matchAll(SLASH)) add(m.index!, m[1]!, "slash");
  for (const m of text.matchAll(LINK_UP)) {
    const name = linkSkillName(m[1]!);
    if (name) add(m.index!, name, "link");
  }
  for (const m of text.matchAll(LINK_SKILLS)) add(m.index!, m[1]!, "link");

  hits.sort((a, b) => a.at - b.at);
  const seen = new Set<string>();
  const out: SkillRef[] = [];
  for (const h of hits) {
    const key = `${h.ref.kind}|${h.ref.ns ?? ""}|${h.ref.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...h.ref, fenced: isFenced(ranges, h.at), at: h.at });
  }
  return out;
}

// ---- resolution -------------------------------------------------------------

export interface DepSource {
  id: number;
  owner: string;
  /** host/owner/repo of its source repo, lower case, or null (an upload). */
  repo: string | null;
  /** Folder under the repo, or null. */
  dir: string | null;
  /** Names this skill itself answers to (slug tail, folder). A reference to one of
   *  them (or, for a `name-2` twin, to `name`) is the skill talking about itself, not a
   *  dependency on a twin of it. */
  names?: string[];
}

export interface DepTarget {
  id: number;
  owner: string;
  repo: string | null;
  dir: string | null;
  /** The repo's own name, for matching a `plugin:skill` namespace. */
  repoName: string | null;
  /** Hash of its body; candidates that share one are copies of the same skill. */
  sha?: string | null;
}

/** Where candidates come from. Both return live (public) skills whose folder name,
 *  slug tail or frontmatter name equals `name`; the resolver drops the caller. */
export interface DepIndex {
  inRepo(repo: string, name: string): DepTarget[];
  ofOwner(owner: string, name: string): DepTarget[];
}

export type Resolution =
  | { status: "resolved"; id: number; tier: "repo" | "owner"; byPath: boolean; twin?: true }
  | { status: "ambiguous"; tier: "repo" | "owner"; count: number }
  | { status: "unresolved" };

const segs = (dir: string | null): string[] => (dir ? dir.toLowerCase().split("/").filter(Boolean) : []);
const common = (a: string[], b: string[]): number => {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
};

/** One tier's verdict: a lone candidate, else the plugin namespace, else (inside a
 *  repo only) the folder that shares the longest path with the caller, else copies of
 *  one body (lowest id), else ambiguous. */
function pick(cands: DepTarget[], ref: Pick<SkillRef, "ns">, from: DepSource, tier: "repo" | "owner"): Resolution {
  if (cands.length === 1) return { status: "resolved", id: cands[0]!.id, tier, byPath: false };
  if (ref.ns) {
    const byNs = cands.filter((c) => c.repoName === ref.ns);
    if (byNs.length === 1) return { status: "resolved", id: byNs[0]!.id, tier, byPath: false };
  }
  if (tier === "repo") {
    const mine = segs(from.dir);
    const scored = cands.map((c) => ({ c, n: common(mine, segs(c.dir)) })).sort((a, b) => b.n - a.n);
    if (scored[0]!.n > scored[1]!.n) return { status: "resolved", id: scored[0]!.c.id, tier, byPath: true };
  }
  const sha = cands[0]!.sha;
  if (sha && cands.every((c) => c.sha === sha)) {
    return { status: "resolved", id: Math.min(...cands.map((c) => c.id)), tier, byPath: false, twin: true };
  }
  return { status: "ambiguous", tier, count: cands.length };
}

const distinct = (cands: DepTarget[], selfId: number): DepTarget[] => {
  const seen = new Set<number>();
  return cands.filter((c) => c.id !== selfId && !seen.has(c.id) && seen.add(c.id));
};

export function resolveRef(ref: Pick<SkillRef, "name" | "ns">, from: DepSource, index: DepIndex): Resolution {
  // a mention of the skill's own name, or of the un-numbered name of its numbered twin
  // (kotlin-coroutines-2 saying "kotlin-coroutines"), is the skill talking about itself
  if (from.names?.some((n) => n === ref.name || n.replace(/-\d{1,2}$/, "") === ref.name)) return { status: "unresolved" };
  if (from.repo) {
    const inRepo = distinct(index.inRepo(from.repo, ref.name), from.id);
    if (inRepo.length) return pick(inRepo, ref, from, "repo");
  }
  const ofOwner = distinct(index.ofOwner(from.owner, ref.name), from.id);
  if (ofOwner.length) return pick(ofOwner, ref, from, "owner");
  return { status: "unresolved" };
}

// ---- source_repo URLs --------------------------------------------------------

/** `https://github.com/o/r[/tree/<branch>/<dir>]` -> its repo key and folder. A branch
 *  name containing a slash leaks its tail into `dir`; harmless for path proximity. */
export function repoKeyOf(url: string | null | undefined): { repo: string | null; repoName: string | null; dir: string | null } {
  const none = { repo: null, repoName: null, dir: null };
  if (!url) return none;
  const m = /^https?:\/\/(?:www\.)?([^/\s]+)\/([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:\/(?:tree|blob)\/[^/]+(?:\/(.*?))?)?\/?$/i.exec(url.trim());
  if (!m) return none;
  const host = m[1]!.toLowerCase();
  const owner = m[2]!.toLowerCase();
  const name = m[3]!.toLowerCase();
  const dir = m[4] ? m[4].replace(/\/+$/, "") : "";
  return { repo: `${host}/${owner}/${name}`, repoName: name, dir: dir || null };
}
