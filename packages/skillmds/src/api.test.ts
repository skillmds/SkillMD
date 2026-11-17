import { describe, it, expect, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { parseSkillMd } from "@skillmds/core";
import { createClient, timedFetch, reconstructSkillMd, skillMdFor, fetchBundle, IntegrityError, RegistryError, isAllowedSourceUrl } from "./api.js";
import { MAX_PACK_BYTES } from "./limits.js";
import { describeFailure } from "./retry.js";

// createClient resolves its base + token through config.ts, so every client
// built here is handed empty sources: the developer's real ~/.skillmd/config.json
// and process.env must never reach a test.
const NO_SOURCES = { env: {}, config: {} } as const;

const sha = (s: string) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
// Minimal Response stand-in for the bundle JSON endpoint.
const bundleResponse = (files: unknown[]) => ({ ok: true, json: async () => ({ files }) });

describe("fetchBundle integrity", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("accepts a registry-stored file whose bytes match the reported sha256", async () => {
    const body = "print('hello')\n";
    vi.stubGlobal("fetch", vi.fn(async () => bundleResponse([{ path: "run.py", content_base64: b64(body), sha256: sha(body) }])));
    const out = await fetchBundle("https://api.test", "owner/pack");
    expect(out).not.toBeNull();
    expect(out!.find((f) => f.path === "run.py")!.contents.toString("utf8")).toBe(body);
  });

  it("throws IntegrityError when the bytes do not match the reported sha256", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => bundleResponse([{ path: "run.py", content_base64: b64("tampered"), sha256: sha("original") }])));
    await expect(fetchBundle("https://api.test", "owner/pack")).rejects.toBeInstanceOf(IntegrityError);
  });

  it("does not verify files that carry no sha256 (reconstructed inline SKILL.md)", async () => {
    const md = "---\nname: x\n---\nbody\n";
    vi.stubGlobal("fetch", vi.fn(async () => bundleResponse([{ path: "SKILL.md", content_base64: b64(md), storage: "inline" }])));
    const out = await fetchBundle("https://api.test", "owner/pack");
    expect(out!.find((f) => f.path === "SKILL.md")!.contents.toString("utf8")).toBe(md);
  });

  it("refuses to fetch a source_url pointing off the GitHub raw hosts (SSRF guard)", async () => {
    const fetchMock = vi.fn(async (input: any) => {
      // Only the bundle endpoint should ever be fetched; the evil source_url must not.
      if (String(input).endsWith("/bundle?format=json")) {
        return bundleResponse([{ path: "run.py", source_url: "http://169.254.169.254/latest/meta-data/", storage: "github" }]) as any;
      }
      throw new Error(`unexpected fetch: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const out = await fetchBundle("https://api.test", "owner/pack");
    expect(out).toEqual([]); // evil file skipped, never requested
    expect(fetchMock).toHaveBeenCalledTimes(1); // bundle only — no SSRF fetch
  });
});

describe("isAllowedSourceUrl", () => {
  it("allows pinned GitHub raw hosts over https", () => {
    expect(isAllowedSourceUrl("https://raw.githubusercontent.com/o/r/abc123/x.py")).toBe(true);
    expect(isAllowedSourceUrl("https://gist.githubusercontent.com/o/id/raw/x")).toBe(true);
  });
  it("refuses non-GitHub hosts, non-https, and internal/metadata addresses", () => {
    expect(isAllowedSourceUrl("http://raw.githubusercontent.com/o/r/x")).toBe(false); // not https
    expect(isAllowedSourceUrl("https://evil.com/x")).toBe(false);
    expect(isAllowedSourceUrl("http://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(isAllowedSourceUrl("http://localhost:8787/admin")).toBe(false);
    expect(isAllowedSourceUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedSourceUrl("not a url")).toBe(false);
  });
});

describe("api() error classification", () => {
  it("tags HTTP failures with their status (proxy 403, registry 5xx)", async () => {
    const f = vi.fn(async () => ({ ok: false, status: 403, text: async () => "egress denied" })) as unknown as typeof fetch;
    const { api } = createClient({ api: "https://api.test" }, { fetch: f, sources: NO_SOURCES });
    const err = await api("/api/skills/o/n").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RegistryError);
    expect((err as RegistryError).status).toBe(403);
    expect((err as RegistryError).message).toContain("403");
  });

  it("tags network-level failures without a status (DNS, refused connection)", async () => {
    const f = vi.fn(async () => { throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND api.test") }); }) as unknown as typeof fetch;
    const { api } = createClient({ api: "https://api.test" }, { fetch: f, sources: NO_SOURCES });
    const err = await api("/api/skills/o/n").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RegistryError);
    expect((err as RegistryError).status).toBeUndefined();
    expect((err as RegistryError).message).toContain("ENOTFOUND");
  });

  it("names the deadline when the request times out (bare TimeoutError)", async () => {
    const f = (async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); }) as unknown as typeof fetch;
    const c = createClient({ api: "https://api.test" }, { fetch: f, sources: NO_SOURCES, timeoutMs: 5000 });
    await expect(c.api("/x")).rejects.toThrow(/timed out after 5s/);
  });

  it("names the deadline when the TimeoutError arrives as a cause", async () => {
    // undici wraps the abort: TypeError("fetch failed") { cause: TimeoutError }.
    const f = (async () => {
      const inner = new Error("The operation was aborted due to timeout");
      inner.name = "TimeoutError";
      throw new TypeError("fetch failed", { cause: inner });
    }) as unknown as typeof fetch;
    const c = createClient({ api: "https://api.test" }, { fetch: f, sources: NO_SOURCES, timeoutMs: 5000 });
    await expect(c.api("/x")).rejects.toThrow(/timed out after 5s/);
  });
});

describe("reconstructSkillMd", () => {
  it("round-trips descriptions with YAML-hostile characters", () => {
    const skill = {
      slug: "owner/tricky",
      title: "tricky",
      description: 'Use when: user says "plan #1", or {weird} stuff',
      body_md: "# Body\n",
      license: "MIT",
    };
    const raw = reconstructSkillMd(skill);
    const parsed = parseSkillMd(raw);
    expect("error" in parsed).toBe(false);
    if (!("error" in parsed)) {
      expect(parsed.name).toBe("tricky");
      expect(parsed.description).toBe('Use when: user says "plan #1", or {weird} stuff');
      expect(parsed.license).toBe("MIT");
      expect(parsed.body).toContain("# Body");
    }
  });
});

describe("skillMdFor", () => {
  it("returns raw_md verbatim when present, ignoring body_md/description", () => {
    const skill = {
      slug: "owner/verbatim",
      title: "verbatim",
      description: "ignored description",
      body_md: "ignored body",
      raw_md: "---\nname: verbatim\ndescription: exact raw content\n---\n\n# Exact\n",
    };
    expect(skillMdFor(skill)).toBe(skill.raw_md);
  });

  it("returns raw_md verbatim even when description diverges from its frontmatter", () => {
    // Publish-time override divergence: a publisher supplied name/description
    // override form fields that changed the registry's title/description columns
    // (for search/display), but raw_md preserves the author's original frontmatter.
    // Installs must deliver the author's SKILL.md verbatim, NOT the overridden fields.
    const skill = {
      slug: "owner/override-divergence",
      title: "Registry Display Title",
      description: "overridden registry description for search",
      body_md: "reconstructed body that must be ignored",
      raw_md: "---\nname: authors-name\ndescription: the author's original description\n---\n\n# Author Body\n",
    };
    expect(skillMdFor(skill)).toBe(skill.raw_md);
    // guard: the reconstructed form (built from the overridden columns) is NOT what installs get
    expect(skillMdFor(skill)).not.toBe(reconstructSkillMd(skill));
  });

  it("falls back to reconstruction when raw_md is absent", () => {
    const skill = {
      slug: "owner/tricky",
      title: "tricky",
      description: 'Use when: user says "plan #1", or {weird} stuff',
      body_md: "# Body\n",
      license: "MIT",
    };
    expect(skillMdFor(skill)).toBe(reconstructSkillMd(skill));
  });
});

type FetchLike = typeof fetch;
const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("fetchBundle hard integrity + caps", () => {
  it("verifies base64 files and refuses a mismatch", async () => {
    const f: FetchLike = async () => jsonResponse({ files: [{ path: "a.txt", content_base64: Buffer.from("hi").toString("base64"), sha256: sha("nope") }] });
    await expect(fetchBundle("https://api.test", "o/n", undefined, { fetch: f })).rejects.toBeInstanceOf(IntegrityError);
  });
  it("installs a hashless source_url file but flags it unverified", async () => {
    // The registry records hashes only for companions whose bytes it hosts.
    // A link back to the source repo with no hash must still install — it is
    // the same https-from-an-allow-listed-host trust as the GitHub fallback —
    // but the caller has to be able to tell the two apart.
    const f: FetchLike = async (url) => {
      if (String(url).includes("/bundle")) return jsonResponse({ files: [
        { path: "SKILL.md", content_base64: Buffer.from("# s").toString("base64"), sha256: sha("# s") },
        { path: "ref.md", source_url: "https://raw.githubusercontent.com/o/r/abc/ref.md", sha256: sha("REF") },
        { path: "nohash.md", source_url: "https://raw.githubusercontent.com/o/r/abc/nohash.md" },
      ] });
      return new Response("REF", { status: 200 });
    };
    const out = await fetchBundle("https://api.test", "o/n", undefined, { fetch: f });
    expect(out?.map((x) => x.path)).toEqual(["SKILL.md", "ref.md", "nohash.md"]);
    expect(out?.find((x) => x.path === "nohash.md")?.unverified).toBe(true);
    expect(out?.find((x) => x.path === "ref.md")?.unverified).toBeUndefined();
    expect(out?.find((x) => x.path === "SKILL.md")?.unverified).toBeUndefined();
  });

  it("still refuses a hashless file the registry served inline", async () => {
    // Nothing to check these bytes against and no generated-file excuse: the
    // registry's record is broken, so the install stops.
    const f: FetchLike = async () => jsonResponse({ files: [
      { path: "ref.md", content_base64: Buffer.from("REF").toString("base64"), storage: "r2" },
    ] });
    await expect(fetchBundle("https://api.test", "o/n", undefined, { fetch: f })).rejects.toThrow(/ref\.md.*no sha256/);
  });

  it("refuses a source_url file whose fetched bytes contradict the recorded hash", async () => {
    const f: FetchLike = async (url) => String(url).includes("/bundle")
      ? jsonResponse({ files: [{ path: "ref.md", source_url: "https://raw.githubusercontent.com/o/r/abc/ref.md", sha256: sha("EXPECTED") }] })
      : new Response("TAMPERED", { status: 200 });
    await expect(fetchBundle("https://api.test", "o/n", undefined, { fetch: f })).rejects.toBeInstanceOf(IntegrityError);
  });
  // 287k registry companions are links to files their repos have since
  // deleted or moved. One of them used to fail the whole bundle.
  it("skips a linked file the source repo no longer serves and reports it, when asked to", async () => {
    const f: FetchLike = async (url) => {
      if (String(url).includes("/bundle")) return jsonResponse({ files: [
        { path: "SKILL.md", content_base64: Buffer.from("# s").toString("base64"), sha256: sha("# s") },
        { path: "references/gone.md", source_url: "https://raw.githubusercontent.com/o/r/main/references/gone.md" },
        { path: "references/kept.md", source_url: "https://raw.githubusercontent.com/o/r/main/references/kept.md" },
      ] });
      return String(url).includes("gone") ? new Response("404: Not Found", { status: 404 }) : new Response("KEPT", { status: 200 });
    };
    const missing: string[] = [];
    const out = await fetchBundle("https://api.test", "o/n", undefined, { fetch: f, missing });
    expect(out?.map((x) => x.path)).toEqual(["SKILL.md", "references/kept.md"]);
    expect(missing).toEqual(["references/gone.md"]);
    // Without a list to report into (an update), the fetch still fails as a whole.
    await expect(fetchBundle("https://api.test", "o/n", undefined, { fetch: f })).rejects.toThrow(/gone\.md/);
  });
  it("accepts a bundle whose url-delivered file matches its hash", async () => {
    const f: FetchLike = async (url) => String(url).includes("/bundle")
      ? jsonResponse({ files: [{ path: "ref.md", source_url: "https://raw.githubusercontent.com/o/r/abc/ref.md", sha256: sha("REF") }] })
      : new Response("REF", { status: 200 });
    const out = await fetchBundle("https://api.test", "o/n", undefined, { fetch: f });
    expect(out?.map((x) => x.path)).toEqual(["ref.md"]);
  });
  it("enforces the pack caps before returning", async () => {
    const files = Array.from({ length: 201 }, (_, i) => ({ path: `f${i}.md`, content_base64: Buffer.from("x").toString("base64"), sha256: sha("x") }));
    const f: FetchLike = async () => jsonResponse({ files });
    await expect(fetchBundle("https://api.test", "o/n", undefined, { fetch: f })).rejects.toThrow(/too large/);
  });
  it("enforces the byte cap on the decoded contents, not the file count", async () => {
    // Two halves-plus-a-bit: each is under the cap on its own, together they blow it.
    const half = Buffer.alloc(Math.floor(MAX_PACK_BYTES / 2) + 1024, "a");
    const content_base64 = half.toString("base64");
    const sha256 = createHash("sha256").update(half).digest("hex");
    const files = [
      { path: "a.bin", content_base64, sha256 },
      { path: "b.bin", content_base64, sha256 },
    ];
    // A plain stand-in, not a real Response: serialising ~28MB of base64 to JSON
    // only to parse it back would make this test needlessly slow.
    const f = (async () => ({ ok: true, json: async () => ({ files }) })) as unknown as FetchLike;
    await expect(fetchBundle("https://api.test", "o/n", undefined, { fetch: f })).rejects.toThrow(/too large/);
  });
  it("passes an abort signal to every fetch", async () => {
    let sawSignal = false;
    const f: FetchLike = async (_url, init) => { sawSignal = Boolean(init?.signal); return jsonResponse({ files: [] }); };
    await fetchBundle("https://api.test", "o/n", undefined, { fetch: f });
    expect(sawSignal).toBe(true);
  });
});

describe("timedFetch", () => {
  it("supplies a deadline signal when the caller has none", async () => {
    let seen: AbortSignal | null | undefined;
    const f: FetchLike = async (_u, init) => { seen = init?.signal; return jsonResponse({ ok: 1 }); };
    await timedFetch(f, 1000)("https://api.test/x");
    expect(seen).toBeInstanceOf(AbortSignal);
  });

  it("passes a caller-supplied signal through untouched", async () => {
    const mySignal = new AbortController().signal;
    let seen: AbortSignal | null | undefined;
    const f: FetchLike = async (_u, init) => { seen = init?.signal; return jsonResponse({ ok: 1 }); };
    await timedFetch(f, 1000)("https://api.test/x", { signal: mySignal });
    expect(seen).toBe(mySignal);
  });
});

describe("createClient", () => {
  it("attaches a timeout signal and reports the effective host", async () => {
    let sawSignal = false;
    const f: FetchLike = async (_u, init) => { sawSignal = Boolean(init?.signal); return jsonResponse({ ok: 1 }); };
    const c = createClient({ api: "https://api.test" }, { fetch: f, sources: NO_SOURCES });
    await c.api("/x");
    expect(sawSignal).toBe(true);
    expect(c.host).toBe("api.test");
    expect(c.isDefaultHost).toBe(false);
  });

  it("sends the stored token only to the host it is bound to", async () => {
    const config = { token: "sk_1", tokenHost: "api.test" };
    const f: FetchLike = async () => jsonResponse({ ok: 1 });
    expect(createClient({ api: "https://api.test" }, { fetch: f, sources: { env: {}, config } }).hasToken).toBe(true);
    expect(createClient({ api: "https://other.test" }, { fetch: f, sources: { env: {}, config } }).hasToken).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Riding out a busy registry. The retry rules themselves are pinned in
// retry.test.ts; these pin that the client and the bundle fetch use them, and
// that asking for it is the only way to get it (the single-skill path keeps
// answering a 429 at once, as it always did).
// ---------------------------------------------------------------------------
describe("createClient with retry", () => {
  const sleeper = () => {
    const waits: number[] = [];
    return { waits, retry: { sleep: async (ms: number) => { waits.push(ms); }, jitter: () => 0 } };
  };
  const answers = (...rs: Response[]) => {
    let n = 0;
    const f = (async () => rs[Math.min(n++, rs.length - 1)]!.clone()) as unknown as FetchLike;
    return { f, calls: () => n };
  };

  it("retries a 429 and returns the answer that follows", async () => {
    const s = sleeper();
    const a = answers(new Response("slow down", { status: 429, headers: { "retry-after": "2" } }), jsonResponse({ ok: 1 }));
    const c = createClient({ api: "https://api.test" }, { fetch: a.f, sources: NO_SOURCES, retry: s.retry });
    await expect(c.api("/x")).resolves.toEqual({ ok: 1 });
    expect(a.calls()).toBe(2);
    expect(s.waits).toEqual([2000]);
  });

  it("gives up on a 429 that will not clear, saying how long the server asked for", async () => {
    const s = sleeper();
    const a = answers(new Response("", { status: 429, headers: { "retry-after": "30" } }));
    const c = createClient({ api: "https://api.test" }, { fetch: a.f, sources: NO_SOURCES, retry: s.retry });
    const err = (await c.api("/x").catch((e) => e)) as RegistryError;
    expect(err).toBeInstanceOf(RegistryError);
    expect(err.status).toBe(429);
    expect(err.message).toBe("rate limited by the SkillMD API, try again in 30 s");
    expect(a.calls()).toBe(1);
  });

  it("does not retry a 404", async () => {
    const s = sleeper();
    const a = answers(new Response("nope", { status: 404 }));
    const c = createClient({ api: "https://api.test" }, { fetch: a.f, sources: NO_SOURCES, retry: s.retry });
    await expect(c.api("/x")).rejects.toMatchObject({ status: 404 });
    expect(a.calls()).toBe(1);
  });

  it("keeps the old behaviour, one attempt, when no retry is asked for", async () => {
    const a = answers(new Response("slow down", { status: 429, headers: { "retry-after": "1" } }), jsonResponse({ ok: 1 }));
    const c = createClient({ api: "https://api.test" }, { fetch: a.f, sources: NO_SOURCES });
    await expect(c.api("/x")).rejects.toMatchObject({ status: 429 });
    expect(a.calls()).toBe(1);
  });

  it("still words a network failure the way it always did", async () => {
    const s = sleeper();
    const f = (async () => { throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND api.test") }); }) as unknown as FetchLike;
    const c = createClient({ api: "https://api.test" }, { fetch: f, sources: NO_SOURCES, retry: s.retry });
    await expect(c.api("/x")).rejects.toThrow(/could not reach https:\/\/api\.test: getaddrinfo ENOTFOUND/);
    expect(s.waits).toEqual([1000, 2000, 4000]);
  });

  it("gives the client's own fetch the same retries", async () => {
    const s = sleeper();
    const a = answers(new Response("", { status: 503 }), new Response("zip", { status: 200 }));
    const c = createClient({ api: "https://api.test" }, { fetch: a.f, sources: NO_SOURCES, retry: s.retry });
    const r = await c.fetch("https://api.test/zip");
    expect(await r.text()).toBe("zip");
    expect(s.waits).toEqual([1000]);
  });
});

describe("fetchBundle on a busy registry", () => {
  const retry = () => {
    const waits: number[] = [];
    return { waits, retry: { sleep: async (ms: number) => { waits.push(ms); }, jitter: () => 0 } };
  };
  const SKILL = { path: "SKILL.md", content_base64: Buffer.from("# s").toString("base64"), sha256: sha("# s") };

  it("retries the bundle request when asked to", async () => {
    const r = retry();
    let n = 0;
    const f: FetchLike = async () => (n++ === 0 ? new Response("", { status: 429, headers: { "retry-after": "1" } }) : jsonResponse({ files: [SKILL] }));
    const out = await fetchBundle("https://api.test", "o/n", undefined, { fetch: f, retry: r.retry });
    expect(out?.map((x) => x.path)).toEqual(["SKILL.md"]);
    expect(r.waits).toEqual([1000]);
  });

  it("retries a companion link too", async () => {
    const r = retry();
    let linkTries = 0;
    const f: FetchLike = async (url) => {
      if (String(url).includes("/bundle")) return jsonResponse({ files: [SKILL, { path: "ref.md", source_url: "https://raw.githubusercontent.com/o/r/abc/ref.md", sha256: sha("REF") }] });
      return linkTries++ === 0 ? new Response("", { status: 503 }) : new Response("REF", { status: 200 });
    };
    const out = await fetchBundle("https://api.test", "o/n", undefined, { fetch: f, retry: r.retry });
    expect(out?.map((x) => x.path)).toEqual(["SKILL.md", "ref.md"]);
    expect(r.waits).toEqual([1000]);
  });

  it("still answers null for an unavailable bundle unless told to be strict", async () => {
    const r = retry();
    const f: FetchLike = async () => new Response("", { status: 404 });
    await expect(fetchBundle("https://api.test", "o/n", undefined, { fetch: f, retry: r.retry })).resolves.toBeNull();
  });

  describe("strict", () => {
    it("says why the bundle could not be had instead of answering null", async () => {
      const r = retry();
      const f: FetchLike = async () => new Response("", { status: 429, headers: { "retry-after": "2" } });
      const err = await fetchBundle("https://api.test", "o/n", undefined, { fetch: f, retry: r.retry, strict: true }).catch((e) => e);
      expect(err).toBeInstanceOf(RegistryError);
      expect(err.status).toBe(429);
      expect(describeFailure(err)).toBe("HTTP 429, retry in 2 s");
    });

    it("names a plain HTTP failure of the bundle request", async () => {
      const f: FetchLike = async () => new Response("", { status: 404 });
      const err = await fetchBundle("https://api.test", "o/n", undefined, { fetch: f, strict: true }).catch((e) => e);
      expect(err).toBeInstanceOf(RegistryError);
      expect(err.status).toBe(404);
    });

    it("names a network failure of the bundle request", async () => {
      const f = (async () => { throw new TypeError("fetch failed"); }) as unknown as FetchLike;
      await expect(fetchBundle("https://api.test", "o/n", undefined, { fetch: f, strict: true })).rejects.toThrow(/could not reach https:\/\/api\.test/);
    });

    it("names the companion it could not get and why", async () => {
      const r = retry();
      const f: FetchLike = async (url) => String(url).includes("/bundle")
        ? jsonResponse({ files: [SKILL, { path: "agents/openai.yaml", source_url: "https://raw.githubusercontent.com/o/r/abc/openai.yaml" }] })
        : new Response("", { status: 429, headers: { "retry-after": "2" } });
      const missing: string[] = [];
      const err = await fetchBundle("https://api.test", "o/n", undefined, { fetch: f, retry: r.retry, strict: true, missing }).catch((e) => e);
      expect(err).toBeInstanceOf(RegistryError);
      expect(err.message).toBe("could not fetch agents/openai.yaml: HTTP 429, retry in 2 s");
      // A busy registry is not a file that is gone: nothing is reported as missing.
      expect(missing).toEqual([]);
    });

    it("still treats a companion the source repo has deleted as gone, not failed", async () => {
      const f: FetchLike = async (url) => String(url).includes("/bundle")
        ? jsonResponse({ files: [SKILL, { path: "references/gone.md", source_url: "https://raw.githubusercontent.com/o/r/main/references/gone.md" }] })
        : new Response("404: Not Found", { status: 404 });
      const missing: string[] = [];
      const out = await fetchBundle("https://api.test", "o/n", undefined, { fetch: f, strict: true, missing });
      expect(out?.map((x) => x.path)).toEqual(["SKILL.md"]);
      expect(missing).toEqual(["references/gone.md"]);
    });

    it("refuses a bundle response that holds no file list", async () => {
      const f: FetchLike = async () => jsonResponse({ nope: true });
      await expect(fetchBundle("https://api.test", "o/n", undefined, { fetch: f, strict: true })).rejects.toThrow(/unreadable/);
    });

    it("still returns a good bundle", async () => {
      const f: FetchLike = async () => jsonResponse({ files: [SKILL] });
      const out = await fetchBundle("https://api.test", "o/n", undefined, { fetch: f, strict: true });
      expect(out?.map((x) => x.path)).toEqual(["SKILL.md"]);
    });
  });
});
