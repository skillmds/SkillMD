// Installing a registry plugin from one manifest and one archive.
//
// `GET /api/packs/:owner/:slug/manifest` lists, for every member in the
// plugin's own order, the directory it has inside the archive and its companion
// files (path, size, sha256, url). `GET .../download` is the archive itself.
// Two requests give every member's full file set; only a companion the archive
// does not hold (the server rations GitHub-hosted ones) is fetched on its own,
// from the url the manifest gives for it.
//
// Nothing here installs a member whose files could not all be obtained: a
// member that fails comes back with a `failure` and no files, and the caller
// turns that into a blocked skill instead of a SKILL.md-only copy of a pack.
import { createHash } from "node:crypto";
import { isAllowedSourceUrl } from "@skillmds/core";
import { RegistryError } from "./errors.js";
import { MAX_PACK_BYTES, MAX_PACK_FILES } from "./limits.js";
import { describeFailure } from "./retry.js";
import type { SkillFileInput } from "./installer.js";

export interface ManifestFile {
  path: string;
  /** Hex sha256 the registry recorded, or null for a link back to the source repo. */
  sha256: string | null;
  url: string;
  size_bytes?: number;
  storage?: string;
}

export interface ManifestMember {
  slug: string;
  /** Authoritative: this member's directory inside the archive (collisions already resolved). */
  dir: string;
  type?: "single" | "pack";
  verified?: boolean;
  /** Companion files only. SKILL.md is not listed; it is always `<dir>/SKILL.md`. */
  files: ManifestFile[];
}

export interface PackManifest { name: string; members: ManifestMember[] }

const HEX64 = /^[0-9a-f]{64}$/i;

/** The manifest, or null when this is not one this CLI understands (a newer
 *  `format`, a malformed body) so the caller can take the older route instead. */
export function parseManifest(body: unknown): PackManifest | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { format?: unknown; name?: unknown; slug?: unknown; members?: unknown };
  if (b.format !== 1 || !Array.isArray(b.members)) return null;
  const dirs = new Set<string>();
  const members: ManifestMember[] = [];
  for (const raw of b.members) {
    if (!raw || typeof raw !== "object") return null;
    const m = raw as { slug?: unknown; dir?: unknown; type?: unknown; verified?: unknown; files?: unknown };
    if (typeof m.slug !== "string" || !m.slug || typeof m.dir !== "string" || !m.dir) return null;
    // Two members in one directory would install the second over the first.
    if (dirs.has(m.dir)) return null;
    dirs.add(m.dir);
    const listed = m.files === undefined ? [] : m.files;
    if (!Array.isArray(listed)) return null;
    const files: ManifestFile[] = [];
    for (const rf of listed) {
      if (!rf || typeof rf !== "object") return null;
      const f = rf as { path?: unknown; sha256?: unknown; url?: unknown; size_bytes?: unknown; storage?: unknown };
      if (typeof f.path !== "string" || !f.path || typeof f.url !== "string" || !f.url) return null;
      if (f.sha256 !== null && f.sha256 !== undefined && (typeof f.sha256 !== "string" || !HEX64.test(f.sha256))) return null;
      files.push({
        path: f.path,
        sha256: typeof f.sha256 === "string" ? f.sha256.toLowerCase() : null,
        url: f.url,
        ...(typeof f.size_bytes === "number" ? { size_bytes: f.size_bytes } : {}),
        ...(typeof f.storage === "string" ? { storage: f.storage } : {}),
      });
    }
    members.push({
      slug: m.slug,
      dir: m.dir,
      ...(m.type === "single" || m.type === "pack" ? { type: m.type } : {}),
      verified: Boolean(m.verified),
      files,
    });
  }
  return { name: typeof b.name === "string" && b.name ? b.name : typeof b.slug === "string" ? b.slug : "plugin", members };
}

function authHeaders(accept: string, token?: string): Record<string, string> {
  const headers: Record<string, string> = { accept };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

/** The plugin's manifest, or null when the registry has none to give: no such
 *  route (an older or self-hosted registry), an error other than a busy one, or
 *  a body this CLI cannot read. A registry that stayed busy past the retries, or
 *  that cannot be reached, throws instead: the older route would only meet the
 *  same wall, harder. */
export async function fetchPackManifest(
  doFetch: typeof fetch,
  base: string,
  owner: string,
  slug: string,
  token?: string,
): Promise<PackManifest | null> {
  const res = await doFetch(`${base}/api/packs/${owner}/${slug}/manifest`, { headers: authHeaders("application/json", token) });
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  return parseManifest(body);
}

/** The plugin archive, as bytes. */
export async function fetchPackZip(
  base: string,
  owner: string,
  slug: string,
  token: string | undefined,
  doFetch: typeof fetch = fetch,
): Promise<Uint8Array> {
  const res = await doFetch(`${base}/api/packs/${owner}/${slug}/download`, { headers: authHeaders("application/zip", token) });
  if (!res.ok) throw new RegistryError(`SkillMD API ${res.status} on /api/packs/${owner}/${slug}/download`, res.status);
  return new Uint8Array(await res.arrayBuffer());
}

export interface ArchiveMember extends ManifestMember {
  /** The member's SKILL.md, read from the archive. */
  raw: string;
}

export interface PluginArchive {
  name: string;
  /** Members whose SKILL.md is in the archive, in the plugin's order. */
  members: ArchiveMember[];
  /** Slugs of members the manifest lists but the archive does not hold. */
  missing: string[];
  entries: Record<string, Uint8Array>;
}

/** Open the archive against the manifest: only the entries the manifest names
 *  are inflated, so an archive carrying anything else costs nothing. */
export async function openPluginArchive(manifest: PackManifest, zip: Uint8Array): Promise<PluginArchive> {
  const { unzipSync, strFromU8 } = await import("fflate");
  const wanted = new Set<string>();
  for (const m of manifest.members) {
    wanted.add(`${m.dir}/SKILL.md`);
    for (const f of m.files) wanted.add(`${m.dir}/${f.path}`);
  }
  // An entry claiming to inflate past the pack cap is left shut; a companion
  // that needed it is then a gap, and a gap is fetched under the same cap.
  const entries = unzipSync(zip, { filter: (e) => wanted.has(e.name) && e.originalSize <= MAX_PACK_BYTES });
  const members: ArchiveMember[] = [];
  const missing: string[] = [];
  for (const m of manifest.members) {
    const sk = entries[`${m.dir}/SKILL.md`];
    if (!sk) { missing.push(m.slug); continue; }
    members.push({ ...m, raw: strFromU8(sk) });
  }
  return { name: manifest.name, members, missing, entries };
}

export interface PluginNet {
  /** Retrying, with a timeout per attempt (createClient's `fetch`). */
  fetch: typeof fetch;
  base: string;
  token?: string;
  /** Gap fetches in flight at once. Default 6. */
  concurrency?: number;
}

export interface CompletedMember {
  member: ArchiveMember;
  /** SKILL.md first, then every companion in the manifest's order. Absent when `failure` is set. */
  files?: SkillFileInput[];
  /** Companions that carry no checksum on record. */
  unverified: number;
  /** Why this member cannot be installed. */
  failure?: string;
}

/** A path that stays inside the skill's own directory. */
function safeRelPath(p: string): boolean {
  if (!p || p.startsWith("/") || p.includes("\\") || /^[a-z]:/i.test(p)) return false;
  return !p.split("/").some((seg) => seg === ".." || seg === "." || seg === "");
}

const shaOf = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function integrityFailure(path: string, want: string, got: string): string {
  return `integrity check failed for "${path}" (expected ${want.slice(0, 12)}…, got ${got.slice(0, 12)}…)`;
}

/** Where a listed file may be fetched from. The manifest names the registry by
 *  its public address; this install only ever talks to the registry it was
 *  pointed at, so an /api/ path is read from there, wherever the manifest says
 *  it lives. The GitHub raw hosts stay allowed; anything else is refused. */
function gapUrl(url: string, base: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (isAllowedSourceUrl(url)) return u.href;
  let b: URL;
  try { b = new URL(base); } catch { return null; }
  if (u.origin === b.origin) return u.href;
  if (u.pathname.startsWith("/api/")) return `${base.replace(/\/+$/, "")}${u.pathname}${u.search}`;
  return null;
}

function failureText(e: unknown): string {
  if (e instanceof RegistryError) return describeFailure(e);
  if (e instanceof Error) return (e.cause as Error | undefined)?.message ?? e.message;
  return String(e);
}

interface Slot { file: ManifestFile; bytes?: Buffer; failure?: string }
interface Work {
  member: ArchiveMember;
  slots: Slot[];
  unverified: number;
  total: number;
  failure?: string;
}

/**
 * Every given member's complete file set. Members are independent: one that
 * cannot be completed (a gap that never arrives, a checksum that disagrees, a
 * path that escapes the skill) is reported with its reason and the rest carry on.
 */
export async function completeMembers(archive: PluginArchive, members: ArchiveMember[], net: PluginNet): Promise<CompletedMember[]> {
  const works: Work[] = members.map((member) => ({ member, slots: member.files.map((file) => ({ file })), unverified: 0, total: 0 }));
  const gaps: { work: Work; slot: Slot }[] = [];

  for (const w of works) {
    const { member } = w;
    if (member.files.length + 1 > MAX_PACK_FILES) { w.failure = `pack too large: > ${MAX_PACK_FILES} files`; continue; }
    const bad = member.files.find((f) => !safeRelPath(f.path));
    if (bad) { w.failure = `unsafe path "${bad.path}" in the plugin manifest`; continue; }
    w.total = archive.entries[`${member.dir}/SKILL.md`]?.length ?? 0;
    for (const slot of w.slots) {
      const data = archive.entries[`${member.dir}/${slot.file.path}`];
      if (!data) { gaps.push({ work: w, slot }); continue; }
      accept(w, slot, Buffer.from(data));
      if (slot.failure) break;
    }
  }

  // Gaps run through a small pool. A member that has already failed is not
  // worth another request, so its remaining gaps are dropped at the door.
  const queue = gaps.filter((g) => !g.work.failure);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < queue.length; i = next++) {
      const { work, slot } = queue[i]!;
      if (work.failure) continue;
      await fetchGap(work, slot, net);
    }
  };
  await Promise.all(Array.from({ length: Math.min(net.concurrency ?? 6, queue.length) }, worker));

  return works.map((w): CompletedMember => {
    // Gaps finish in any order; the reason given is the first one in the manifest's.
    w.failure = w.slots.find((s) => s.failure)?.failure ?? w.failure;
    if (w.failure) return { member: w.member, unverified: 0, failure: w.failure };
    const sk = archive.entries[`${w.member.dir}/SKILL.md`]!;
    return {
      member: w.member,
      unverified: w.unverified,
      files: [{ path: "SKILL.md", contents: Buffer.from(sk) }, ...w.slots.map((s) => ({ path: s.file.path, contents: s.bytes! }))],
    };
  });
}

/** Record why a file could not be had. The member is out; its other gaps are skipped. */
function fail(w: Work, slot: Slot, why: string): void {
  slot.failure = why;
  w.failure ??= why;
}

/** Put a file's bytes in its slot, after the size and checksum checks. */
function accept(w: Work, slot: Slot, bytes: Buffer): void {
  w.total += bytes.length;
  if (w.total > MAX_PACK_BYTES) { fail(w, slot, `pack too large: > ${Math.round(MAX_PACK_BYTES / (1024 * 1024))}MB`); return; }
  const want = slot.file.sha256;
  if (want) {
    const got = shaOf(bytes);
    if (got !== want) { fail(w, slot, integrityFailure(slot.file.path, want, got)); return; }
  } else {
    w.unverified++;
  }
  slot.bytes = bytes;
}

async function fetchGap(w: Work, slot: Slot, net: PluginNet): Promise<void> {
  const path = slot.file.path;
  const url = gapUrl(slot.file.url, net.base);
  if (!url) { fail(w, slot, `could not fetch ${path}: ${slot.file.url} is not an address this install fetches from`); return; }
  const headers: Record<string, string> = {};
  try {
    // The token belongs to the registry. A GitHub raw host never sees it.
    if (net.token && new URL(url).origin === new URL(net.base).origin) headers.authorization = `Bearer ${net.token}`;
  } catch { /* an unparseable base was refused above */ }
  let res: Response;
  try {
    res = await net.fetch(url, { headers });
  } catch (e) {
    fail(w, slot, `could not fetch ${path}: ${failureText(e)}`);
    return;
  }
  if (!res.ok) { fail(w, slot, `could not fetch ${path}: HTTP ${res.status}`); return; }
  const declared = Number(res.headers.get("content-length"));
  if (declared > MAX_PACK_BYTES) { fail(w, slot, `pack too large: > ${Math.round(MAX_PACK_BYTES / (1024 * 1024))}MB`); return; }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    fail(w, slot, `could not fetch ${path}: ${failureText(e)}`);
    return;
  }
  accept(w, slot, bytes);
}
