import { describe, it, expect, vi } from "vitest";
import { openUrl, openerFor } from "./openUrl.js";
import type { SpawnLike } from "./openUrl.js";

/** A spawn stand-in that records the call and lets a test fire the child's 'error'. */
function fakeSpawn() {
  const calls: { cmd: string; args: readonly string[]; opts: Record<string, unknown> }[] = [];
  const handlers: Record<string, () => void> = {};
  const unref = vi.fn();
  const spawn: SpawnLike = (cmd, args, opts) => {
    calls.push({ cmd, args, opts: opts as Record<string, unknown> });
    return { on: (ev: string, cb: () => void) => { handlers[ev] = cb; }, unref };
  };
  return { spawn, calls, handlers, unref };
}

const URL_OK = "https://skillmd.com/cli/authorize?code=ABCD-EFGH";

describe("openerFor", () => {
  it("picks each platform's own opener and passes the URL as one argument (never through a shell)", () => {
    expect(openerFor("win32", URL_OK)).toEqual({ cmd: "rundll32", args: ["url.dll,FileProtocolHandler", URL_OK] });
    expect(openerFor("darwin", URL_OK)).toEqual({ cmd: "open", args: [URL_OK] });
    expect(openerFor("linux", URL_OK)).toEqual({ cmd: "xdg-open", args: [URL_OK] });
    expect(openerFor("freebsd", URL_OK)).toEqual({ cmd: "xdg-open", args: [URL_OK] });
  });
});

describe("openUrl", () => {
  it("launches the opener detached with silenced stdio, lets it outlive the CLI, and reports true", () => {
    const f = fakeSpawn();
    expect(openUrl(URL_OK, { platform: "linux", spawn: f.spawn })).toBe(true);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.cmd).toBe("xdg-open");
    expect(f.calls[0]!.args).toEqual([URL_OK]);
    expect(f.calls[0]!.opts).toMatchObject({ stdio: "ignore", detached: true });
    expect(f.unref).toHaveBeenCalledOnce();
  });
  it("never throws when the opener cannot be spawned, and reports false", () => {
    const boom: SpawnLike = () => { throw new Error("spawn ENOENT"); };
    expect(openUrl(URL_OK, { platform: "linux", spawn: boom })).toBe(false);
  });
  it("swallows the child's async 'error' (no xdg-open on a headless box)", () => {
    const f = fakeSpawn();
    openUrl(URL_OK, { platform: "linux", spawn: f.spawn });
    expect(typeof f.handlers.error).toBe("function");
    expect(() => f.handlers.error!()).not.toThrow();
  });
  it("only ever opens http(s): any other scheme (file:, javascript:, a custom handler) is refused without spawning", () => {
    const f = fakeSpawn();
    for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "ms-msdt:/id", "calc.exe", "", "-flag"]) {
      expect(openUrl(bad, { platform: "win32", spawn: f.spawn })).toBe(false);
    }
    expect(f.calls).toHaveLength(0);
  });
});
