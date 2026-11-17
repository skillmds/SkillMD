import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { strToU8, zipSync } from "fflate";
import { retryingFetch } from "./retry.js";
import { completeMembers, fetchPackManifest, fetchPackZip, openPluginArchive, parseManifest } from "./plugin.js";
import type { ManifestMember, PackManifest } from "./plugin.js";

const sha = (s: string) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
const BASE = "https://api.test";

const zipOf = (entries: Record<string, string>) => zipSync(Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, strToU8(v)])));
const file = (path: string, body: string | null, extra: { sha?: string | null; url?: string } = {}) => ({
  path,
  size_bytes: body?.length ?? 0,
  sha256: extra.sha !== undefined ? extra.sha : body === null ? null : sha(body),
  storage: "r2",
  url: extra.url ?? `${BASE}/api/skills/o/x/files/${path}`,
});
const member = (dir: string, files: ReturnType<typeof file>[] = []): ManifestMember => ({
  slug: `o/${dir}`, dir, type: files.length ? "pack" : "single", verified: false, files,
});
const manifestOf = (members: ManifestMember[]): PackManifest => ({ name: "Test Plugin", members });

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const fastRetry = () => {
  const waits: number[] = [];
  return { waits, opts: { sleep: async (ms: number) => { waits.push(ms); }, jitter: () => 0 } };
};

describe("parseManifest", () => {
  const good = { format: 1, slug: "o/p", name: "P", download: "https://api.test/api/packs/o/p/download", members: [
    { slug: "o/tdd", dir: "tdd", type: "pack", verified: false, files: [{ path: "agents/openai.yaml", size_bytes: 3, sha256: "a".repeat(64), storage: "r2", url: "https://api.test/x" }] },
    { slug: "o/pr", dir: "pr", type: "single", verified: true, files: [] },
  ] };

  it("reads the members in the order the plugin defines them", () => {
    const m = parseManifest(good)!;
    expect(m.name).toBe("P");
    expect(m.members.map((x) => [x.slug, x.dir, x.type, x.verified])).toEqual([["o/tdd", "tdd", "pack", false], ["o/pr", "pr", "single", true]]);
    expect(m.members[0]!.files[0]).toMatchObject({ path: "agents/openai.yaml", sha256: "a".repeat(64), url: "https://api.test/x" });
  });

  it("accepts a companion with no checksum on record", () => {
    const m = parseManifest({ ...good, members: [{ slug: "o/a", dir: "a", files: [{ path: "f", sha256: null, url: "https://api.test/f" }] }] })!;
    expect(m.members[0]!.files[0]!.sha256).toBeNull();
  });

  it("refuses a format it does not know, so the caller can fall back", () => {
    expect(parseManifest({ ...good, format: 2 })).toBeNull();
    expect(parseManifest({ ...good, format: undefined })).toBeNull();
  });

  it("refuses anything that is not a manifest", () => {
    expect(parseManifest(null)).toBeNull();
    expect(parseManifest("nope")).toBeNull();
    expect(parseManifest({ format: 1, members: "x" })).toBeNull();
    expect(parseManifest({ format: 1, members: [{ slug: "o/a" }] })).toBeNull(); // no dir
    expect(parseManifest({ format: 1, members: [{ slug: "o/a", dir: "a", files: [{ path: "f", sha256: "short", url: "u" }] }] })).toBeNull();
    expect(parseManifest({ format: 1, members: [{ slug: "o/a", dir: "a", files: [{ sha256: null, url: "u" }] }] })).toBeNull(); // no path
  });

  it("refuses two members that would land in the same directory", () => {
    expect(parseManifest({ format: 1, members: [{ slug: "a/x", dir: "x", files: [] }, { slug: "b/x", dir: "x", files: [] }] })).toBeNull();
  });
});

describe("fetchPackManifest", () => {
  const manifestBody = { format: 1, name: "P", members: [{ slug: "o/a", dir: "a", type: "single", verified: false, files: [] }] };

  it("asks for the manifest once, with the token", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const f = (async (url: string, init?: RequestInit) => { seen.push({ url, headers: init?.headers as Record<string, string> }); return json(manifestBody); }) as unknown as typeof fetch;
    const m = await fetchPackManifest(f, BASE, "o", "p", "sk_t");
    expect(m?.members.map((x) => x.dir)).toEqual(["a"]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(`${BASE}/api/packs/o/p/manifest`);
    expect(seen[0]!.headers.authorization).toBe("Bearer sk_t");
  });

  it("answers null when the registry has no such route (404, 405, a 500, junk)", async () => {
    for (const make of [
      () => json({ error: "not_found" }, 404),
      () => new Response("", { status: 405 }),
      () => new Response("boom", { status: 500 }),
      () => new Response("<html>", { status: 200 }),
      () => json({ format: 9 }),
    ]) {
      const f = (async () => make()) as unknown as typeof fetch;
      await expect(fetchPackManifest(f, BASE, "o", "p")).resolves.toBeNull();
    }
  });

  it("lets a rate limit that outlasted the retries through, instead of quietly falling back", async () => {
    const r = fastRetry();
    const f = retryingFetch((async () => new Response("", { status: 429, headers: { "retry-after": "1" } })) as unknown as typeof fetch, r.opts);
    await expect(fetchPackManifest(f, BASE, "o", "p")).rejects.toMatchObject({ status: 429 });
  });

  it("lets a network failure through", async () => {
    const f = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    await expect(fetchPackManifest(f, BASE, "o", "p")).rejects.toThrow(/fetch failed/);
  });
});

describe("fetchPackZip", () => {
  it("returns the archive bytes, and says what failed otherwise", async () => {
    const zip = zipOf({ "a/SKILL.md": "# a" });
    const ok = (async () => new Response(zip, { status: 200 })) as unknown as typeof fetch;
    expect((await fetchPackZip(BASE, "o", "p", undefined, ok)).length).toBe(zip.length);
    const bad = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    await expect(fetchPackZip(BASE, "o", "p", undefined, bad)).rejects.toMatchObject({ status: 404 });
  });
});

describe("openPluginArchive", () => {
  it("reads each member's SKILL.md and names the members the archive does not hold", async () => {
    const zip = zipOf({ "a/SKILL.md": "# a", "c/SKILL.md": "# c", "README.md": "x", "b/other.md": "x" });
    const arch = await openPluginArchive(manifestOf([member("a"), member("b"), member("c")]), zip);
    expect(arch.members.map((m) => [m.dir, m.raw])).toEqual([["a", "# a"], ["c", "# c"]]);
    expect(arch.missing).toEqual(["o/b"]);
  });
});

describe("completeMembers", () => {
  const net = (f: typeof fetch, extra: { token?: string } = {}) => ({ fetch: f, base: BASE, token: extra.token });
  const never = (async () => { throw new Error("no request expected"); }) as unknown as typeof fetch;

  async function run(m: PackManifest, entries: Record<string, string>, f: typeof fetch = never, extra: { token?: string } = {}) {
    const arch = await openPluginArchive(m, zipOf(entries));
    return completeMembers(arch, arch.members, net(f, extra));
  }

  it("builds every file set from the archive alone, in manifest order, with no request", async () => {
    const m = manifestOf([member("a", [file("agents/openai.yaml", "Y"), file("refs/z.md", "Z")]), member("b")]);
    const out = await run(m, { "a/SKILL.md": "# a", "a/agents/openai.yaml": "Y", "a/refs/z.md": "Z", "b/SKILL.md": "# b" });
    expect(out.map((o) => o.failure)).toEqual([undefined, undefined]);
    expect(out[0]!.files!.map((x) => [x.path, x.contents.toString()])).toEqual([["SKILL.md", "# a"], ["agents/openai.yaml", "Y"], ["refs/z.md", "Z"]]);
    expect(out[1]!.files!.map((x) => x.path)).toEqual(["SKILL.md"]);
  });

  it("counts companions the registry holds no checksum for", async () => {
    const m = manifestOf([member("a", [file("f.md", "F", { sha: null }), file("g.md", "G")])]);
    const out = await run(m, { "a/SKILL.md": "# a", "a/f.md": "F", "a/g.md": "G" });
    expect(out[0]!.unverified).toBe(1);
  });

  it("blocks only the member whose archive bytes contradict the recorded checksum", async () => {
    const m = manifestOf([member("a", [file("f.md", "REAL")]), member("b", [file("g.md", "G")])]);
    const out = await run(m, { "a/SKILL.md": "# a", "a/f.md": "TAMPERED", "b/SKILL.md": "# b", "b/g.md": "G" });
    expect(out[0]!.files).toBeUndefined();
    expect(out[0]!.failure).toMatch(/integrity check failed for "f\.md"/);
    expect(out[1]!.failure).toBeUndefined();
    expect(out[1]!.files).toHaveLength(2);
  });

  describe("gaps (listed, but not in the archive)", () => {
    it("fetches each from its own url and checks it", async () => {
      const urls: string[] = [];
      const f = (async (u: string) => { urls.push(u); return new Response("Y", { status: 200 }); }) as unknown as typeof fetch;
      const m = manifestOf([member("a", [file("agents/openai.yaml", "Y"), file("refs/z.md", "Z")])]);
      const out = await run(m, { "a/SKILL.md": "# a", "a/refs/z.md": "Z" }, f);
      expect(urls).toEqual([`${BASE}/api/skills/o/x/files/agents/openai.yaml`]);
      expect(out[0]!.failure).toBeUndefined();
      // Still in manifest order, whichever source each came from.
      expect(out[0]!.files!.map((x) => x.path)).toEqual(["SKILL.md", "agents/openai.yaml", "refs/z.md"]);
    });

    it("rides out a 429 on a gap with the retry helper", async () => {
      const r = fastRetry();
      let n = 0;
      const raw = (async () => (n++ === 0 ? new Response("", { status: 429, headers: { "retry-after": "2" } }) : new Response("Y", { status: 200 }))) as unknown as typeof fetch;
      const m = manifestOf([member("a", [file("agents/openai.yaml", "Y")])]);
      const out = await run(m, { "a/SKILL.md": "# a" }, retryingFetch(raw, r.opts));
      expect(out[0]!.failure).toBeUndefined();
      expect(r.waits).toEqual([2000]);
    });

    it("blocks the member, with the reason, when a gap never arrives", async () => {
      const r = fastRetry();
      const raw = (async (u: string) => (String(u).includes("/bad/")
        ? new Response("", { status: 429, headers: { "retry-after": "2" } })
        : new Response("OK", { status: 200 }))) as unknown as typeof fetch;
      const m = manifestOf([
        member("a", [file("agents/openai.yaml", "Y", { url: `${BASE}/api/skills/o/bad/files/agents/openai.yaml` }), file("later.md", "L", { url: `${BASE}/api/skills/o/bad/files/later.md` })]),
        member("b", [file("g.md", "OK", { url: `${BASE}/api/skills/o/ok/files/g.md` })]),
      ]);
      const out = await run(m, { "a/SKILL.md": "# a", "b/SKILL.md": "# b" }, retryingFetch(raw, r.opts));
      expect(out[0]!.files).toBeUndefined();
      expect(out[0]!.failure).toBe("could not fetch agents/openai.yaml: HTTP 429, retry in 2 s");
      expect(out[1]!.failure).toBeUndefined();
      expect(out[1]!.files!.map((x) => x.path)).toEqual(["SKILL.md", "g.md"]);
    });

    it("names a plain HTTP failure", async () => {
      const f = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
      const out = await run(manifestOf([member("a", [file("f.md", "F")])]), { "a/SKILL.md": "# a" }, f);
      expect(out[0]!.failure).toBe("could not fetch f.md: HTTP 404");
    });

    it("blocks the member when what arrives contradicts the checksum", async () => {
      const f = (async () => new Response("WRONG", { status: 200 })) as unknown as typeof fetch;
      const out = await run(manifestOf([member("a", [file("f.md", "RIGHT")])]), { "a/SKILL.md": "# a" }, f);
      expect(out[0]!.failure).toMatch(/integrity check failed for "f\.md"/);
    });

    it("takes a file with no checksum as it comes, and counts it", async () => {
      const f = (async () => new Response("ANY", { status: 200 })) as unknown as typeof fetch;
      const out = await run(manifestOf([member("a", [file("f.md", "x", { sha: null })])]), { "a/SKILL.md": "# a" }, f);
      expect(out[0]!.failure).toBeUndefined();
      expect(out[0]!.unverified).toBe(1);
      expect(out[0]!.files![1]!.contents.toString()).toBe("ANY");
    });

    it("only ever talks to the registry it was pointed at, or the GitHub raw hosts", async () => {
      const urls: string[] = [];
      const f = (async (u: string) => { urls.push(String(u)); return new Response("X", { status: 200 }); }) as unknown as typeof fetch;
      const m = manifestOf([member("a", [
        file("pub.md", "X", { url: "https://api.skillmd.com/api/skills/o/a/files/pub.md" }),   // the registry's public address
        file("raw.md", "X", { url: "https://raw.githubusercontent.com/o/r/abc/raw.md" }),      // an allow-listed host
        file("evil.md", "X", { url: "https://evil.test/steal" }),                              // neither
        file("meta.md", "X", { url: "http://169.254.169.254/latest/meta-data/" }),             // neither
      ])]);
      const out = await run(m, { "a/SKILL.md": "# a" }, f);
      expect(urls).toEqual([`${BASE}/api/skills/o/a/files/pub.md`, "https://raw.githubusercontent.com/o/r/abc/raw.md"]);
      expect(out[0]!.failure).toMatch(/could not fetch (evil|meta)\.md: .*not an address/);
    });

    it("sends the token to the registry and to nobody else", async () => {
      const seen: Record<string, string | undefined> = {};
      const f = (async (u: string, init?: RequestInit) => { seen[String(u)] = (init?.headers as Record<string, string> | undefined)?.authorization; return new Response("X", { status: 200 }); }) as unknown as typeof fetch;
      const m = manifestOf([member("a", [
        file("a.md", "X", { url: `${BASE}/api/skills/o/a/files/a.md` }),
        file("raw.md", "X", { url: "https://raw.githubusercontent.com/o/r/abc/raw.md" }),
      ])]);
      await run(m, { "a/SKILL.md": "# a" }, f, { token: "sk_secret" });
      expect(seen[`${BASE}/api/skills/o/a/files/a.md`]).toBe("Bearer sk_secret");
      expect(seen["https://raw.githubusercontent.com/o/r/abc/raw.md"]).toBeUndefined();
    });

    it("fetches six at a time, no more", async () => {
      let inFlight = 0;
      let peak = 0;
      const f = (async () => {
        inFlight++; peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return new Response("X", { status: 200 });
      }) as unknown as typeof fetch;
      const members = Array.from({ length: 5 }, (_, i) => member(`m${i}`, [file("a.md", "X"), file("b.md", "X"), file("c.md", "X"), file("d.md", "X")]));
      const entries = Object.fromEntries(members.map((m) => [`${m.dir}/SKILL.md`, "# s"]));
      const out = await run(manifestOf(members), entries, f);
      expect(out.every((o) => !o.failure)).toBe(true);
      expect(peak).toBe(6);
    });
  });

  it("refuses a companion path that climbs out of the skill, and blocks only that member", async () => {
    const m = manifestOf([member("a", [file("../escape.md", "X")]), member("b")]);
    const out = await run(m, { "a/SKILL.md": "# a", "b/SKILL.md": "# b" });
    expect(out[0]!.failure).toMatch(/unsafe path "\.\.\/escape\.md"/);
    expect(out[1]!.failure).toBeUndefined();
  });

  it("refuses a member that lists more files than a skill may hold", async () => {
    const files = Array.from({ length: 200 }, (_, i) => file(`f${i}.md`, "X"));
    const entries: Record<string, string> = { "a/SKILL.md": "# a" };
    for (let i = 0; i < 200; i++) entries[`a/f${i}.md`] = "X";
    const out = await run(manifestOf([member("a", files)]), entries);
    expect(out[0]!.failure).toMatch(/too large/);
  });

  it("completes only the members it is given", async () => {
    const m = manifestOf([member("a", [file("f.md", "F")]), member("b", [file("g.md", "G")])]);
    const arch = await openPluginArchive(m, zipOf({ "a/SKILL.md": "# a", "a/f.md": "F", "b/SKILL.md": "# b" }));
    const out = await completeMembers(arch, [arch.members[0]!], net(never));
    expect(out.map((o) => o.member.dir)).toEqual(["a"]); // b's missing file is never asked for
  });
});
