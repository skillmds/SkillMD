// Skill dependencies, at install time: one resolver for `skillmd add` and the
// stdio MCP's skillmd_install.
//
// A skill whose body says `Call the Skill tool with "grilling"` is an empty shell
// without grilling. Installing a skill therefore also installs the skills it
// depends on, and says so. This module works out which; writing them is the
// caller's business, so they get the caller's own scope, agents, mode and gates.
//
// Two ways to learn the dependencies, tried in this order:
//   1. The registry's closure: ONE request per root skill,
//      GET /api/skills/:owner/:name/deps?depth=3&kinds=skill_tool,invoke,see,link.
//      The registry has already walked the graph, resolved every name inside the
//      author's own namespace and dropped what is not public, so there is nothing
//      to walk here and nothing to ask about a dependency.
//   2. The SKILL.md bodies themselves (extractSkillRefs), when the endpoint is
//      unavailable for any reason, or the run has too many roots to spend that
//      many requests on (the API allows about five a second per IP). References of
//      kind skill_tool and invoke are followed, three levels deep; each name is
//      looked for in what the run already holds first (the same plugin or source)
//      and only then, for a skill that came from the registry, among the same
//      owner's skills. Never another owner's.
//
// Hard dependencies (skill_tool, invoke) install on their own. Soft ones (see,
// link) are only listed as related and install with --with-related. A hard edge
// that hangs off a soft parent is not hard: nothing needed it.
import { extractSkillRefs } from "./deps.js";

/** The registry's JSON GET: throws on any answer that is not a success. */
export type Api = <T = unknown>(path: string, init?: RequestInit) => Promise<T>;

/** One dependency as the closure lists it. */
export interface DepEdge {
  /** owner/name. */
  slug: string;
  /** How the edge that first reached it was written: skill_tool, invoke, see, link. */
  kind: string;
  depth: number;
  /** The slug of the skill whose body (or page) pointed at it. */
  via: string;
}

export interface Closure { deps: DepEdge[]; truncated: boolean }

/** Edges that make a skill unusable without the other one. */
export const HARD_KINDS: ReadonlySet<string> = new Set(["skill_tool", "invoke"]);
const ENDPOINT_KINDS = "skill_tool,invoke,see,link";
/** How far a dependency is followed. */
export const MAX_DEPTH = 3;
/** Past this many roots a run reads bodies instead of asking the endpoint per root. */
export const MAX_ENDPOINT_ROOTS = 5;

export const depsPath = (slug: string): string => `/api/skills/${slug}/deps?depth=${MAX_DEPTH}&kinds=${ENDPOINT_KINDS}`;

const SLUG = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/i;
const lower = (s: string | undefined) => s?.toLowerCase();
const tail = (slug: string) => slug.split("/")[1] ?? slug;

/** The closure out of a response body, or null when it is not one. Entries that
 *  cannot be trusted (a slug that is not owner/name, which would become a path;
 *  a missing kind or parent) are dropped, and the root is never its own dep. */
export function parseClosure(body: unknown, root: string): Closure | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { deps?: unknown; truncated?: unknown };
  if (!Array.isArray(b.deps)) return null;
  const deps: DepEdge[] = [];
  for (const d of b.deps) {
    if (!d || typeof d !== "object") continue;
    const { slug, kind, depth, via } = d as Record<string, unknown>;
    if (typeof slug !== "string" || !SLUG.test(slug)) continue;
    if (typeof kind !== "string" || !kind) continue;
    if (typeof via !== "string" || !SLUG.test(via)) continue;
    if (lower(slug) === lower(root)) continue;
    deps.push({ slug, kind, depth: typeof depth === "number" && Number.isInteger(depth) && depth >= 1 ? depth : 1, via });
  }
  return { deps, truncated: b.truncated === true };
}

/** The closure of `slug`, in one request; null for any failure at all (404, a
 *  busy registry that stayed busy, a network error, a body that is not a closure). */
export async function fetchClosure(api: Api, slug: string): Promise<Closure | null> {
  try {
    return parseClosure(await api(depsPath(slug)), slug);
  } catch {
    return null;
  }
}

/** Split a closure: what installs on its own, and what is only related. An edge
 *  installs on its own when it is hard and hangs off the root or off a skill that
 *  does. */
export function partitionDeps(root: string, deps: DepEdge[]): { auto: DepEdge[]; related: DepEdge[] } {
  const accepted = new Set([lower(root)!]);
  const auto: DepEdge[] = [];
  const related: DepEdge[] = [];
  // The registry lists breadth-first, so a parent is always met before its
  // children; sorting by depth makes that true of any input.
  for (const e of [...deps].sort((a, b) => a.depth - b.depth)) {
    if (HARD_KINDS.has(e.kind) && accepted.has(lower(e.via)!)) {
      auto.push(e);
      accepted.add(lower(e.slug)!);
    } else related.push(e);
  }
  return { auto, related };
}

/** What the resolver needs to know about a skill. `add` and the MCP tool each
 *  bring their own richer type; this is the part that is shared. */
export interface DepNode {
  /** The name it installs under. */
  name: string;
  /** The folder it came from, when that differs from `name`. */
  slug?: string;
  /** owner/name in the registry, when it has one. */
  registrySlug?: string;
  /** Its SKILL.md. */
  raw: string;
  /** The name of the skill that pulled this one in. */
  usedBy?: string;
  /** That skill's registry slug (its name when it has none). */
  viaSlug?: string;
  /** How the edge that pulled it in was written. */
  depKind?: string;
  /** Why it cannot be installed. A skill that is not going in pulls nothing in. */
  unavailable?: string;
}

/** Turn a registry slug into a skill, or null. `sameRepo` says the slug is a guess
 *  made from a name in a body, so the answer must also be of the same source
 *  repository; false when the registry itself named it. A throw is a miss. */
export type Lookup<T> = (slug: string, ctx: { from: T; sameRepo: boolean }) => Promise<T | null>;

export interface DepHooks<T extends DepNode> {
  /** The registry. Absent: bodies only. */
  api?: Api;
  /** Materialise a registry skill. Absent: only what the pool holds. */
  lookup?: Lookup<T>;
}

/** Is `x` (lowercase) this skill's name, folder or registry name? */
function answersTo(n: DepNode, x: string): boolean {
  return lower(n.name) === x || lower(n.slug) === x || lower(n.registrySlug?.split("/")[1]) === x;
}

/** What one resolution knows: what is in the run, what has been pulled, what the
 *  registry has already been asked (a miss is remembered too). */
function resolution<T extends DepNode>(pool: T[], lookup: Lookup<T> | undefined, inRun: T[]) {
  const pulled: T[] = [];
  const asked = new Map<string, Promise<T | null>>();
  const has = (name: string) => inRun.some((n) => answersTo(n, name)) || pulled.some((n) => answersTo(n, name));

  const ask = (slug: string, from: T, sameRepo: boolean): Promise<T | null> => {
    if (!lookup || !SLUG.test(slug)) return Promise.resolve(null);
    const key = `${lower(slug)}|${sameRepo}`;
    let p = asked.get(key);
    if (!p) {
      p = lookup(slug, { from, sameRepo }).catch(() => null);
      asked.set(key, p);
    }
    return p;
  };

  const add = (target: T, usedBy: string, viaSlug: string, kind: string): T => {
    const copy = { ...target, usedBy, viaSlug, depKind: kind };
    pulled.push(copy);
    return copy;
  };

  /** The name a parent is shown under: the run's own name for it, else its slug's tail. */
  const shown = (viaSlug: string): string =>
    [...inRun, ...pulled].find((n) => lower(n.registrySlug) === lower(viaSlug))?.name ?? tail(viaSlug);

  /** The registry named this dependency. */
  const pullEdge = async (e: DepEdge, root: T): Promise<void> => {
    if (has(tail(e.slug).toLowerCase())) return;
    const target = pool.find((p) => lower(p.registrySlug) === lower(e.slug)) ?? (await ask(e.slug, root, false));
    if (!target || has(target.name.toLowerCase())) return;
    add(target, shown(e.via), e.via, e.kind);
  };

  /** Follow the hard references in bodies, `MAX_DEPTH` deep. */
  const walk = async (root: T): Promise<void> => {
    let frontier = [{ node: root, depth: 0 }];
    while (frontier.length) {
      const next: typeof frontier = [];
      for (const { node, depth } of frontier) {
        if (depth >= MAX_DEPTH || node.unavailable) continue;
        for (const ref of extractSkillRefs(node.raw)) {
          if (!HARD_KINDS.has(ref.kind) || answersTo(node, ref.name) || has(ref.name)) continue;
          // The same plugin or source first; then the same owner, and only that.
          let target: T | null | undefined = pool.find((p) => answersTo(p, ref.name));
          const owner = node.registrySlug?.split("/")[0];
          if (!target && owner) target = await ask(`${owner}/${ref.name}`, node, true);
          if (!target || has(target.name.toLowerCase())) continue;
          next.push({ node: add(target, node.name, node.registrySlug ?? node.name, ref.kind), depth: depth + 1 });
        }
      }
      frontier = next;
    }
  };

  return { pulled, has, pullEdge, walk };
}

/** `selected` and the skills their bodies call (the fallback, on its own). */
export async function expandByBodies<T extends DepNode>(
  selected: T[],
  pool: T[],
  lookup?: Lookup<T>,
  opts: { inRun?: T[] } = {},
): Promise<T[]> {
  const r = resolution(pool, lookup, opts.inRun ?? selected);
  for (const root of selected) await r.walk(root);
  return [...selected, ...r.pulled];
}

export interface DepsResult<T> {
  /** Skills to install besides the roots, each with `usedBy`. */
  pulled: T[];
  /** Dependencies that were found and not installed (soft, or hanging off a soft one). */
  related: DepEdge[];
  /** The registry cut a closure short; what it listed was still installed. */
  truncated: boolean;
}

/**
 * Everything the roots depend on. Per root, the endpoint when the run is small
 * enough to afford it and answers; otherwise the bodies. `pool` is what the run
 * already holds (the plugin's members, a repo's skills): consulted before the
 * registry. `opts.inRun` is every skill already going in; it defaults to `roots`.
 */
export async function resolveDeps<T extends DepNode>(
  roots: T[],
  pool: T[],
  hooks: DepHooks<T>,
  opts: { withRelated?: boolean; inRun?: T[] } = {},
): Promise<DepsResult<T>> {
  const r = resolution(pool, hooks.lookup, opts.inRun ?? roots);
  const useEndpoint = Boolean(hooks.api) && roots.length <= MAX_ENDPOINT_ROOTS;
  const related: DepEdge[] = [];
  let truncated = false;

  for (const root of roots) {
    if (root.unavailable) continue;
    if (useEndpoint && root.registrySlug) {
      const closure = await fetchClosure(hooks.api!, root.registrySlug);
      if (closure) {
        truncated ||= closure.truncated;
        const { auto, related: soft } = partitionDeps(root.registrySlug, closure.deps);
        for (const e of opts.withRelated ? closure.deps : auto) await r.pullEdge(e, root);
        if (!opts.withRelated) for (const e of soft) if (!related.some((x) => lower(x.slug) === lower(e.slug))) related.push(e);
        continue;
      }
    }
    await r.walk(root);
  }
  return { pulled: r.pulled, related: related.filter((e) => !r.has(tail(e.slug).toLowerCase())), truncated };
}
