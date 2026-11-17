// Pointer skills, at install time.
//
// A skill whose whole job is "Call the Skill tool with grilling" is an empty
// shell without grilling. When one is installed, the skills it points at come
// with it: from the same plugin or source first, then from the same owner in
// the registry. This works out which; installing them is `add`'s own business,
// so they get the same scope, agents, mode and gates as the skill that asked.
import { skillPointers } from "./pointers.js";

/** How far a pointer is followed: a skill's pointer, and that one's pointer, no further. */
export const MAX_POINTER_DEPTH = 2;

export interface PointerNode {
  /** The directory/name it installs under. */
  name: string;
  /** The folder it came from, when that differs from `name`. */
  slug?: string;
  /** `owner/name` in the registry, when it has one. */
  registrySlug?: string;
  /** Its SKILL.md. */
  raw: string;
  /** The skill that pulled this one in, when one did. */
  usedBy?: string;
}

const lower = (s: string | undefined) => s?.toLowerCase();

/** Is `x` (lowercase) this skill's name, folder or registry name? */
function answersTo(n: PointerNode, x: string): boolean {
  return lower(n.name) === x || lower(n.slug) === x || lower(n.registrySlug?.split("/")[1]) === x;
}

/**
 * `selected`, then every skill they point at (and, once more, theirs).
 *
 * A pointed skill is looked for in `pool` first, then through `extra` (the
 * registry, for a skill installed on its own). Anything that is not found, or
 * that `extra` fails on, is a miss and nothing more: a pointer never fails an
 * install. A skill already in the run is never added again, which is also what
 * ends a cycle. Pulled-in skills are copies carrying `usedBy`, the skill that
 * pointed at them; what was passed in is not touched.
 */
export async function expandPointers<T extends PointerNode>(
  selected: T[],
  pool: T[],
  opts: { extra?: (name: string, from: T) => Promise<T | null> } = {},
): Promise<T[]> {
  const out = [...selected];
  const inRun = new Set<string>();
  const has = (x: string) => out.some((n) => answersTo(n, x));
  for (const n of selected) inRun.add(n.name.toLowerCase());
  const misses = new Set<string>();

  let frontier = selected.map((node) => ({ node, depth: 0 }));
  while (frontier.length) {
    const next: typeof frontier = [];
    for (const { node, depth } of frontier) {
      if (depth >= MAX_POINTER_DEPTH) continue;
      for (const x of skillPointers(node.raw, node.name)) {
        if (has(x) || misses.has(x)) continue;
        let target: T | null | undefined = pool.find((p) => answersTo(p, x));
        if (!target && opts.extra) {
          try { target = await opts.extra(x, node); } catch { target = null; }
        }
        if (!target || inRun.has(target.name.toLowerCase())) { if (!target) misses.add(x); continue; }
        const pulled = { ...target, usedBy: node.name };
        inRun.add(pulled.name.toLowerCase());
        out.push(pulled);
        next.push({ node: pulled, depth: depth + 1 });
      }
    }
    frontier = next;
  }
  return out;
}
