// Open a page in the user's default browser. A convenience, never a
// requirement: the login flow also prints the URL, so every failure here
// (no opener installed, a headless box, an SSH session) is silent.
import { spawn as nodeSpawn } from "node:child_process";

/** The slice of child_process.spawn this uses, so tests can inject it. */
export type SpawnLike = (
  cmd: string,
  args: readonly string[],
  opts: { stdio: "ignore"; detached: true; windowsHide: true },
) => { on(event: "error", cb: () => void): unknown; unref(): void };

export interface OpenUrlOptions {
  platform?: NodeJS.Platform;
  spawn?: SpawnLike;
}

/** Each platform's own opener. The URL is a single argv entry and never goes
 *  through a shell, so nothing in it can be interpreted as a command (this is
 *  why Windows uses rundll32 rather than `cmd /c start`, which would treat `&`
 *  in a query string as a command separator). */
export function openerFor(platform: NodeJS.Platform, url: string): { cmd: string; args: string[] } {
  if (platform === "win32") return { cmd: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  if (platform === "darwin") return { cmd: "open", args: [url] };
  return { cmd: "xdg-open", args: [url] };
}

/** Try to open `url` in the default browser. Returns whether an opener was
 *  launched (not whether a browser appeared); never throws. Only http(s) is
 *  ever handed to the OS: a file:, javascript: or custom-protocol address would
 *  run something other than a web page. */
export function openUrl(url: string, opts: OpenUrlOptions = {}): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  const { cmd, args } = openerFor(opts.platform ?? process.platform, url);
  try {
    const child = (opts.spawn ?? (nodeSpawn as unknown as SpawnLike))(cmd, args, { stdio: "ignore", detached: true, windowsHide: true });
    child.on("error", () => { /* no opener on this machine: the URL was printed anyway */ });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
