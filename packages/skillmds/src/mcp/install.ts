// skillmd_install: the MCP tool that writes. It goes through exactly the same
// installer the CLI's `skillmd add` uses — one canonical copy in .agents/skills,
// a link from every chosen agent dir, a lock entry recording provenance — so an
// agent-driven install and a human-driven one produce identical trees.
import { resolve } from "node:path";
import { lint, skillMdFor } from "@skillmds/core";
import { fetchBundle, IntegrityError, missingFilesNote } from "../api.js";
import type { RegistrySkill } from "../api.js";
import { AGENTS, agentDir, canonicalDir, detectAgents } from "../agents.js";
import { looksLikeProject } from "../project.js";
import { resolvePackFiles } from "../source.js";
import { telemetryDisabled } from "../config.js";
import { installSkill, isInstalled } from "../installer.js";
import type { SkillFileInput } from "../installer.js";
import { resolveDeps, sameRepository } from "../skillDeps.js";
import type { DepNode, Lookup } from "../skillDeps.js";
import { notice, parseSlug } from "./types.js";
import type { ToolContext, ToolResult } from "./types.js";

/** The two network calls this tool makes on a pack's behalf, injectable so a
 *  test can drive the bundle path and the GitHub fallback without a network. */
export interface InstallDeps {
  fetchBundle?: typeof fetchBundle;
  resolvePackFiles?: typeof resolvePackFiles;
}

/** Where a legacy `dest` points. `agent: null` means the cross-agent canonical
 *  root itself — a real destination, but not an agent's dir. */
interface DestTarget {
  agent: string | null;
  global: boolean;
}

/** Legacy `dest`: only a known agent skills dir (project or global) is accepted.
 *  The old server let a caller name any directory, which made "install this
 *  skill" a primitive for writing attacker-chosen bytes anywhere the agent could
 *  reach. A dest now has to BE one of the directories we would have written to
 *  anyway; anything else is refused with instructions to use scope + agents. */
function agentForDest(dest: string, scopeOpts: { cwd?: string; home?: string; env?: NodeJS.ProcessEnv }): DestTarget | null {
  const target = resolve(dest);
  for (const global of [false, true]) {
    // The canonical root is checked BEFORE the agents, because several agents
    // declare that very path as their own (codex in a project; warp and cline
    // globally). Letting one of them claim it would read "install into .agents"
    // as "install into .agents and also link a copy back into it for codex" —
    // naming the canonical root means the canonical copy and nothing else.
    if (resolve(canonicalDir({ ...scopeOpts, global })) === target) return { agent: null, global };
    for (const a of AGENTS) {
      if (global && a.global === null) continue;
      if (resolve(agentDir(a.id, { ...scopeOpts, global })) === target) return { agent: a.id, global };
    }
  }
  return null;
}

/** The contents of the SKILL.md that will actually land on disk, as text. */
function skillMdOf(files: SkillFileInput[]): string | null {
  const f = files.find((x) => x.path === "SKILL.md");
  if (!f) return null;
  return typeof f.contents === "string" ? f.contents : f.contents.toString("utf8");
}

export async function installFromRegistry(args: Record<string, unknown>, ctx: ToolContext, deps: InstallDeps = {}): Promise<ToolResult> {
  const getBundle = deps.fetchBundle ?? fetchBundle;
  const getPackFiles = deps.resolvePackFiles ?? resolvePackFiles;

  // Defense in depth: the name becomes a directory below, so refuse anything
  // outside the registry's slugify alphabet before touching network or disk.
  // Same reading as every other tool — see parseSlug in ./types.ts.
  const parsed = parseSlug(args.slug);
  if (!parsed) return notice(`Refused: invalid slug "${String(args.slug)}" — expected owner/name.`);
  const [owner, name] = parsed;
  const base = { cwd: ctx.cwd, home: ctx.home, env: ctx.env };

  let agents: string[] | undefined = Array.isArray(args.agents) ? (args.agents as unknown[]).map(String) : undefined;
  const dest = typeof args.dest === "string" && args.dest ? args.dest : undefined;
  // dest names one directory, agents names a set of them. Together they are a
  // contradiction, and silently preferring one would install somewhere the
  // caller did not ask for.
  if (dest && agents) return notice("Refused: pass either `dest` or `agents`, not both. `dest` names one directory; prefer scope + agents.");

  let global: boolean;
  // True when `dest` was the canonical root: write the canonical copy and link
  // nothing. explicitAgents rides along so the installer treats the empty agent
  // list as a decision rather than "nothing was detected".
  let canonicalOnly = false;
  if (dest) {
    const hit = agentForDest(dest, base);
    if (!hit) {
      return notice(
        `Refused: dest "${dest}" is not a known agent skills directory. Use scope ("project"|"global") and agents instead; known roots: ${[...new Set(AGENTS.map((a) => a.project.join("/")))].join(", ")}.`,
      );
    }
    global = hit.global;
    if (hit.agent === null) canonicalOnly = true;
    else agents = [hit.agent];
  } else if (args.scope === "project" || args.scope === "global") {
    global = args.scope === "global";
  } else {
    // Same rule as the CLI: project when the cwd looks like one, else global.
    global = !looksLikeProject(resolve(ctx.cwd ?? process.cwd()));
  }
  const scope = { ...base, global };
  const detected = detectAgents(scope);
  const targets = canonicalOnly ? [] : agents?.length ? agents : detected.length ? detected : ["claude-code"];
  for (const a of targets) {
    if (!AGENTS.some((x) => x.id === a)) return notice(`Unknown agent "${a}". Known: ${AGENTS.map((x) => x.id).join(", ")}`);
  }

  // A skill ready to write: the registry's record, vetted, with the files that
  // will land on disk. Used for the skill that was asked for and, by the same
  // rules, for each skill it depends on.
  interface Prepared {
    owner: string;
    name: string;
    skill: RegistrySkill;
    raw: string;
    files: SkillFileInput[];
    note: string;
    flags: string[];
  }
  const deny = Array.isArray(args.deny) ? (args.deny as unknown[]).map(String) : [];

  const prepare = async (o: string, n: string, skill: RegistrySkill): Promise<{ ok: true; pkg: Prepared } | { ok: false; refusal: ToolResult }> => {
    const flags = skill.security_flags ?? [];
    // The caller can pre-declare capabilities it will not accept; an install that
    // trips one is refused before anything is fetched or written. The flags are
    // the registry's own scan of the record, so nothing below can change them —
    // the pack fallback swaps the *bytes*, never the record this test reads.
    const denied = flags.filter((f) => deny.includes(f));
    if (denied.length) return { ok: false, refusal: notice(`Refused: ${o}/${n} carries denied security flags: ${denied.join(", ")}. Not installed.`) };

    const raw = skillMdFor(skill);
    const refuseLint = (content: string): ToolResult | null => {
      const result = lint(content, { slug: n });
      if (result.ok) return null;
      const errors = result.diagnostics.filter((d) => d.severity === "error");
      return notice(`Refused: ${o}/${n} failed validation (${errors.map((d) => `${d.id}: ${d.message}`).join("; ")}). Not installed.`);
    };
    // Cheap gate on the registry's copy first, so a broken record never costs a
    // pack fetch. The bytes that are actually written are linted again below.
    const bad = refuseLint(raw);
    if (bad) return { ok: false, refusal: bad };

    let files: SkillFileInput[] = [{ path: "SKILL.md", contents: raw }];
    let note = "";
    // The bundle for every skill, as the CLI's `add` does: the type doesn't
    // reliably say whether a skill has companion files. Only a pack falls back to
    // GitHub, and only a pack is told its assets are missing.
    const pack = skill.type === "pack";
    try {
      const missing: string[] = [];
      const bundle = await getBundle(ctx.base, `${o}/${n}`, ctx.token, { missing });
      if (bundle?.length) {
        files = bundle.some((f) => f.path === "SKILL.md") ? bundle : [...bundle, { path: "SKILL.md", contents: raw }];
        if (missing.length) note = missingFilesNote(missing);
      } else if (pack) {
        const fromGitHub = await getPackFiles(skill);
        if (fromGitHub) {
          files = fromGitHub.files;
          // resolvePackFiles degrades from the pinned commit to the repo's
          // default branch. That is acceptable — but the caller asked for a
          // pinned revision and did not get one, so say so.
          if (fromGitHub.pinMiss) note = "pinned commit unavailable upstream — fetched the source repo's default branch instead";
        } else note = "pack assets could not be fetched — only SKILL.md was written";
      }
    } catch (e) {
      // A tampered bundle is never a fallback case: refuse the whole install.
      if (e instanceof IntegrityError) return { ok: false, refusal: notice(`Refused: ${o}/${n} failed integrity verification — ${e.message}. Not installed.`) };
      if (pack) note = `pack assets could not be fetched (${e instanceof Error ? e.message : String(e)}) — only SKILL.md was written`;
    }

    // The SKILL.md above is not necessarily the one linted a moment ago: both the
    // bundle and the GitHub fallback can carry their own, and the fallback's came
    // from an unpinned default branch. Lint the bytes that will actually be
    // written, or the gate is on a file nobody installs.
    const written = skillMdOf(files);
    if (written === null) files = [...files, { path: "SKILL.md", contents: raw }];
    else if (written !== raw) {
      const badWritten = refuseLint(written);
      if (badWritten) return { ok: false, refusal: badWritten };
    }
    return { ok: true, pkg: { owner: o, name: n, skill, raw, files, note, flags } };
  };

  const rootRecord = await ctx.api<RegistrySkill>(`/api/skills/${owner}/${name}`);
  const prepared = await prepare(owner, name, rootRecord);
  if (!prepared.ok) return prepared.refusal;
  const { skill, files, note } = prepared.pkg;
  const flags = prepared.pkg.flags;

  // The skills this one depends on (see skillDeps.ts, which `add` uses too).
  // They are vetted by the same rules as the root and written after it; the
  // root never waits on them and is never undone by them.
  interface Node extends DepNode { pkg?: Prepared; refusal?: string; sourceRepo?: string | null }
  const nodeOf = (pkg: Prepared): Node => ({
    name: pkg.name, registrySlug: `${pkg.owner}/${pkg.name}`, raw: skillMdOf(pkg.files) ?? pkg.raw, pkg, sourceRepo: pkg.skill.source_repo,
  });
  const lookup: Lookup<Node> = async (slug, { from, sameRepo }) => {
    const [o, n] = slug.split("/") as [string, string];
    const record = await ctx.api<RegistrySkill>(`/api/skills/${o}/${n}`);
    if (sameRepo && !sameRepository(from.sourceRepo, record.source_repo)) return null;
    const prep = await prepare(o, n, record);
    if (prep.ok) return nodeOf(prep.pkg);
    const reason = prep.refusal.content[0]?.text ?? "refused";
    return { name: n, registrySlug: slug, raw: "", refusal: reason, unavailable: reason };
  };
  const rootNode = nodeOf(prepared.pkg);
  const found = await resolveDeps<Node>([rootNode], [rootNode], { api: ctx.api, lookup }, { withRelated: args.with_related === true });

  let r;
  try {
    r = await installSkill({
      name,
      files,
      source: `registry:${owner}/${name}`,
      commit_sha: skill.commit_sha ?? undefined,
      scope,
      agents: targets,
      explicitAgents: canonicalOnly || Boolean(agents?.length),
      mode: args.mode === "copy" ? "copy" : "link",
      force: Boolean(args.force),
    });
  } catch (e) {
    return notice(`Refused: ${e instanceof Error ? e.message : String(e)}`);
  }

  const countInstall = (o: string, n: string) => {
    if (telemetryDisabled(ctx.env ?? process.env)) return;
    ctx
      .api(`/api/skills/${o}/${n}/install`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ via: "mcp" }),
      })
      .catch(() => {});
  };
  countInstall(owner, name);

  // Each dependency, in the order the registry (or the bodies) named them: the
  // same scope, agents and mode as the root, never forced. One that is already
  // installed is left alone, whatever it came from; one that fails a check is
  // reported and the rest carry on.
  const alsoInstalled: { slug: string; used_by: string }[] = [];
  const alsoBlocked: { slug: string; reason: string }[] = [];
  for (const dep of found.pulled) {
    const slug = dep.registrySlug ?? dep.name;
    if (dep.unavailable || !dep.pkg) { alsoBlocked.push({ slug, reason: dep.unavailable ?? "could not be prepared" }); continue; }
    if (isInstalled(dep.name, scope)) continue;
    try {
      await installSkill({
        name: dep.name,
        files: dep.pkg.files,
        source: `registry:${slug}`,
        commit_sha: dep.pkg.skill.commit_sha ?? undefined,
        scope,
        agents: targets,
        explicitAgents: canonicalOnly || Boolean(agents?.length),
        mode: args.mode === "copy" ? "copy" : "link",
      });
    } catch (e) {
      alsoBlocked.push({ slug, reason: e instanceof Error ? e.message : String(e) });
      continue;
    }
    countInstall(dep.pkg.owner, dep.pkg.name);
    alsoInstalled.push({ slug, used_by: dep.viaSlug ?? `${owner}/${name}` });
  }
  const related = found.related.map((e) => ({ slug: e.slug, kind: e.kind, via: e.via }));

  const summary = {
    installed: true,
    slug: `${owner}/${name}`,
    scope: global ? "global" : "project",
    canonical: r.canonical,
    targets: r.targets,
    skipped: r.skipped,
    // installSkill writes the whole tree or throws, so every file in `files`
    // reached disk — the count is the list's length, not a running tally.
    files_written: files.length,
    security_flags: flags,
    ...(note ? { note } : {}),
    ...(alsoInstalled.length ? { also_installed: alsoInstalled } : {}),
    ...(related.length ? { related } : {}),
    ...(alsoBlocked.length ? { also_blocked: alsoBlocked } : {}),
  };
  const where = r.targets.length
    ? r.targets.map((t) => `${t.agent} → ${t.path} (${t.mode})`).join("; ")
    : `${r.canonical} (canonical only)`;
  const extra = [
    alsoInstalled.length ? ` Also installed (dependencies): ${alsoInstalled.map((d) => `${d.slug} (used by ${d.used_by})`).join(", ")}.` : "",
    alsoBlocked.length ? ` Dependencies not installed: ${alsoBlocked.map((d) => `${d.slug} (${d.reason})`).join("; ")}` : "",
    related.length ? ` Related, not installed: ${related.map((d) => d.slug).join(", ")} (pass with_related to install them).` : "",
  ].join("");
  return {
    content: [
      {
        type: "text",
        text: `Installed ${owner}/${name} [${summary.scope}]: ${where}. ${files.length} file(s); security: ${flags.join(", ") || "unscanned"}.${note ? ` NOTE: ${note}` : ""}${extra}`,
      },
    ],
    structuredContent: summary,
  };
}
