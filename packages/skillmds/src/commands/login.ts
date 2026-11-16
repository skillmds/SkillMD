import { Command } from "commander";
import { readFileSync } from "node:fs";
import pc from "picocolors";
import { readConfig, writeConfig, configPath, hostOf, resolveApi, DEFAULT_API } from "../config.js";
import type { CliConfig } from "../config.js";
import { createClient, RegistryError } from "../api.js";
import type { Client } from "../api.js";
import { detectHostAgent, nonInteractiveHint } from "../env.js";
import { safeText } from "../sanitize.js";
import { openUrl as openInBrowser } from "../openUrl.js";

export interface LoginFlags {
  token?: string;
  api?: string;
  /** Allow an http:// API base (local development only). */
  insecureHttp?: boolean;
  json?: boolean;
  /** Home directory holding ~/.skillmd/config.json. Tests pass a temp dir. */
  home?: string;
  env?: NodeJS.ProcessEnv;
}

/** Everything that touches the outside world, injected so the command stays
 *  testable without a network, a browser, a terminal or a clock. */
export interface LoginDeps {
  /** A person is at a terminal, so a browser login can run. Absent = off a TTY,
   *  or inside an agent or CI, where nobody could approve a code. */
  interactive?: boolean;
  fetch?: typeof fetch;
  /** Open the approval page. Failures are the opener's to swallow. */
  openUrl?: (url: string) => unknown;
  /** Wait `ms`, resolving early when `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  /** Aborted by Ctrl-C. */
  signal?: AbortSignal;
  /** Progress lines (the URL and the code): stdout, or stderr under --json. */
  say?: (line: string) => void;
  /** The device request's User-Agent; the server shows it as the device's name. */
  userAgent?: string;
}

export interface CmdResult { exitCode: 0 | 1; output: string }

const SLOW_DOWN_STEP_MS = 5_000;
const MAX_INTERVAL_S = 60;
/** Consecutive network/5xx failures while polling before the login gives up. */
const MAX_POLL_FAILURES = 5;
/** Revoking is a courtesy on the way out, so it never holds the logout up for long. */
const REVOKE_TIMEOUT_MS = 3_000;
/** A token goes into a header and a file: plain printable ASCII, no spaces. */
const TOKEN_SHAPE = /^[\x21-\x7e]{1,512}$/;

const EXPIRED = "The login code expired before it was approved. Run `skillmd login` again.";
const DENIED = "Login was denied in the browser.";
const UNEXPECTED = "The server sent an unexpected reply to the login request.";

/** Browser login needs a person who can see the code and a browser to approve
 *  it: a terminal, and no agent or CI driving it. The lines go to stdout, or
 *  to stderr under --json, so that is the stream that has to be a terminal. */
function canLoginInBrowser(flags: LoginFlags): boolean {
  if (detectHostAgent(flags.env ?? process.env) !== null) return false;
  if (!process.stdin.isTTY) return false;
  return Boolean(flags.json ? process.stderr.isTTY : process.stdout.isTTY);
}

const defaultLoginDeps = (flags: LoginFlags): LoginDeps => ({ interactive: canLoginInBrowser(flags) });

/** The package's own version, found next to the built files (dist/) or, when
 *  running from source, one level up. Checked by name so an unrelated parent
 *  package.json is never mistaken for it. */
function packageVersion(): string {
  for (const rel of ["../package.json", "../../package.json"]) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8")) as { name?: string; version?: string };
      if (pkg.name === "get-skill" && pkg.version) return pkg.version;
    } catch { /* try the next location */ }
  }
  return "0.0.0";
}

/** `get-skill/<version> (<platform>)`: the server shows it as the device label. */
export function cliUserAgent(version: string = packageVersion(), platform: string = process.platform): string {
  return `get-skill/${version} (${platform})`;
}

/** Wait `ms`; resolves early (not rejecting) if `signal` aborts, so the caller
 *  checks `signal.aborted` and winds down instead of unwinding an exception. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

const ABORTED = Symbol("aborted");

/** `p`, unless `signal` aborts first. The request itself is left to finish or
 *  time out on its own; a late failure of it is already handled here. */
function raceAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T | typeof ABORTED> {
  if (!signal) return p;
  if (signal.aborted) { p.catch(() => {}); return Promise.resolve(ABORTED); }
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

const upper = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** In --json mode stdout carries one document and nothing else: every early
 *  return goes through here so a hint or a cancellation never leaks plain text
 *  into output a caller is parsing. */
function finish(flags: { json?: boolean }, result: CmdResult, doc: unknown): CmdResult {
  return flags.json ? { ...result, output: JSON.stringify(doc, null, 2) } : result;
}

// ---- Browser login (RFC 8628 device code) ----

interface Grant { deviceCode: string; userCode: string; url: string; expiresInMs: number; intervalMs: number }

/** Only an https page (or http on an http:// dev base) is ever printed or
 *  opened: the server's reply must not be able to hand the OS a file:,
 *  javascript: or custom-protocol address. */
function webUrl(value: unknown, allowHttp: boolean): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (allowHttp && url.protocol === "http:") ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function parseGrant(raw: unknown, allowHttp: boolean): Grant | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const deviceCode = typeof r.device_code === "string" ? r.device_code : "";
  const userCode = safeText(r.user_code, 32);
  const url = webUrl(r.verification_uri_complete, allowHttp) ?? webUrl(r.verification_uri, allowHttp);
  if (!deviceCode || !userCode || !url) return null;
  const expires = Number(r.expires_in);
  const interval = Number(r.interval);
  return {
    deviceCode,
    userCode,
    url,
    expiresInMs: (Number.isFinite(expires) && expires > 0 ? expires : 600) * 1000,
    intervalMs: Math.min(MAX_INTERVAL_S, Math.max(1, Number.isFinite(interval) && interval > 0 ? interval : 5)) * 1000,
  };
}

function deviceError(e: unknown, host: string): string {
  if (e instanceof RegistryError && (e.status === 404 || e.status === 405)) {
    return `Browser login is not available on ${host}. Re-run with --token <token> (or set SKILLMD_TOKEN).`;
  }
  if (e instanceof RegistryError && e.status === 429) return "Too many login attempts from this network. Try again in a while.";
  return upper(safeText(e instanceof Error ? e.message : String(e), 300));
}

type Poll =
  | { kind: "token"; token: string }
  | { kind: "pending" }
  | { kind: "slow" }
  | { kind: "expired" }
  | { kind: "denied" }
  | { kind: "transient"; why: string }
  | { kind: "fail"; message: string };

async function pollOnce(client: Client, deviceCode: string): Promise<Poll> {
  let res: Response;
  try {
    res = await client.fetch(`${client.base}/api/cli/token`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ device_code: deviceCode }),
    });
  } catch (e) {
    const why = e instanceof Error ? ((e.cause as Error | undefined)?.message ?? e.message) : String(e);
    return { kind: "transient", why: safeText(why, 200) };
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.ok) {
    const token = body?.access_token;
    return typeof token === "string" && TOKEN_SHAPE.test(token) ? { kind: "token", token } : { kind: "fail", message: UNEXPECTED };
  }
  const code = typeof body?.error === "string" ? body.error : "";
  if (code === "authorization_pending") return { kind: "pending" };
  if (code === "slow_down" || res.status === 429) return { kind: "slow" };
  if (code === "expired_token") return { kind: "expired" };
  if (code === "access_denied") return { kind: "denied" };
  if (res.status >= 500) return { kind: "transient", why: `HTTP ${res.status}` };
  return { kind: "fail", message: `Login failed: ${safeText(code || `HTTP ${res.status}`, 80)}` };
}

type BrowserResult = { token: string } | { cancelled: true } | { error: string };

/** Ask for a device code, show it, and poll until the person approves it in
 *  the browser. Nothing here is stored: the caller writes the token. */
async function browserLogin(flags: LoginFlags, cfg: CliConfig, env: NodeJS.ProcessEnv, host: string, deps: LoginDeps): Promise<BrowserResult> {
  const { signal } = deps;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? abortableSleep;
  const say = deps.say ?? ((line: string) => (flags.json ? console.error : console.log)(line));
  if (signal?.aborted) return { cancelled: true };

  // These two calls are anonymous: a token stored earlier, or SKILLMD_TOKEN,
  // is never sent along. The client still resolves the base (https only) the
  // same way every other command does.
  const { SKILLMD_TOKEN: _ignored, ...anonymousEnv } = env;
  const client = createClient(
    { api: flags.api, insecureHttp: flags.insecureHttp },
    { fetch: deps.fetch, sources: { env: anonymousEnv, config: { ...cfg, api: flags.api ?? cfg.api, token: undefined } } },
  );

  let grant: Grant | null;
  try {
    const raw = await raceAbort(
      client.api<unknown>("/api/cli/device", {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": deps.userAgent ?? cliUserAgent() },
        body: "{}",
      }),
      signal,
    );
    if (raw === ABORTED) return { cancelled: true };
    grant = parseGrant(raw, client.base.startsWith("http://"));
  } catch (e) {
    return { error: deviceError(e, host) };
  }
  if (!grant) return { error: UNEXPECTED };

  say(`Open ${grant.url} and confirm the code ${pc.bold(grant.userCode)}.`);
  say(pc.dim("Waiting for you to approve it in the browser. Ctrl-C to cancel."));
  try { await (deps.openUrl ?? openInBrowser)(grant.url); } catch { /* the URL is printed above */ }

  let intervalMs = grant.intervalMs;
  const expiresAt = now() + grant.expiresInMs;
  let failures = 0;
  for (;;) {
    const left = expiresAt - now();
    if (left <= 0) return { error: EXPIRED };
    await sleep(Math.min(intervalMs, left), signal);
    if (signal?.aborted) return { cancelled: true };
    const step = await raceAbort(pollOnce(client, grant.deviceCode), signal);
    if (step === ABORTED) return { cancelled: true };
    if (step.kind === "token") return { token: step.token };
    if (step.kind === "expired") return { error: EXPIRED };
    if (step.kind === "denied") return { error: DENIED };
    if (step.kind === "fail") return { error: step.message };
    if (step.kind === "transient") {
      if (++failures >= MAX_POLL_FAILURES) return { error: `Could not reach ${host}: ${step.why}` };
      continue;
    }
    failures = 0;
    if (step.kind === "slow") intervalMs += SLOW_DOWN_STEP_MS;
  }
}

export async function runLogin(flags: LoginFlags, deps: LoginDeps = defaultLoginDeps(flags)): Promise<CmdResult> {
  const env = flags.env ?? process.env;
  let token = flags.token;
  // Off a TTY (a pipe, CI, or an agent shell) nobody can approve a browser
  // login and a prompt would hang forever: say what to pass instead and
  // change nothing.
  if (!token && !deps.interactive) {
    const error = `${nonInteractiveHint("--token <token> (or set SKILLMD_TOKEN)")} Or run \`skillmd login\` in a terminal to log in from your browser.`;
    return finish(flags, { exitCode: 1, output: pc.red(error) }, { ok: false, error });
  }

  const cfg = readConfig(flags.home);
  // Bind the token to the host it was issued for — it is never sent anywhere
  // else. Resolve through the same chain the client uses (flag → SKILLMD_API
  // → config → default) so the binding can't miss an env override, and so an
  // http:// base is refused here rather than at the first authenticated call.
  let host: string;
  try {
    host = hostOf(resolveApi({ api: flags.api, insecureHttp: flags.insecureHttp }, { env, config: { ...cfg, api: flags.api ?? cfg.api } }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { exitCode: 1, output: flags.json ? JSON.stringify({ ok: false, error: msg }, null, 2) : pc.red(msg) };
  }

  let viaBrowser = false;
  if (!token) {
    const got = await browserLogin(flags, cfg, env, host, deps);
    if ("cancelled" in got) return finish(flags, { exitCode: 0, output: pc.dim("Cancelled.") }, { ok: false, cancelled: true });
    if ("error" in got) return finish(flags, { exitCode: 1, output: pc.red(got.error) }, { ok: false, error: got.error });
    token = got.token;
    viaBrowser = true;
  }

  cfg.token = token;
  if (flags.api) cfg.api = flags.api;
  cfg.tokenHost = host;
  writeConfig(cfg, flags.home);
  const file = configPath(flags.home);
  return {
    exitCode: 0,
    output: flags.json ? JSON.stringify({ ok: true, file, host }, null, 2) : `${viaBrowser ? "Logged in. " : ""}Saved token for ${host} to ${file}`,
  };
}

// ---- Logout ----

export interface LogoutFlags {
  json?: boolean;
  home?: string;
  env?: NodeJS.ProcessEnv;
  api?: string;
  /** Allow an http:// API base (local development only). */
  insecureHttp?: boolean;
}

export interface LogoutDeps {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Ask the registry to revoke the stored token (it may revoke itself). Best
 *  effort: any failure is just `false`. The stored token goes to its own host
 *  and nowhere else, and never over plain http without --insecure-http. */
async function revokeOnServer(cfg: CliConfig, flags: LogoutFlags, deps: LogoutDeps): Promise<boolean> {
  try {
    const { SKILLMD_TOKEN: _ignored, ...env } = flags.env ?? process.env;
    const make = (api?: string) =>
      createClient({ api, insecureHttp: flags.insecureHttp }, { fetch: deps.fetch, timeoutMs: deps.timeoutMs ?? REVOKE_TIMEOUT_MS, sources: { env, config: cfg } });
    let client = make(flags.api);
    // resolveToken hands the stored token out only for the host it was saved
    // for: when the resolved base is some other host, go to the token's own.
    if (!client.token) client = make(`https://${cfg.tokenHost ?? hostOf(DEFAULT_API)}`);
    if (!client.token) return false;
    await client.api("/api/cli/token", { method: "DELETE" });
    return true;
  } catch {
    return false;
  }
}

export async function runLogout(flags: LogoutFlags, deps: LogoutDeps = {}): Promise<CmdResult> {
  const cfg = readConfig(flags.home);
  const had = Boolean(cfg.token);
  const revoked = had ? await revokeOnServer(cfg, flags, deps) : false;
  delete cfg.token;
  delete cfg.tokenHost;
  writeConfig(cfg, flags.home);
  return {
    exitCode: 0,
    output: flags.json
      ? JSON.stringify({ ok: true, removed: had, revoked }, null, 2)
      : !had ? "No stored token." : revoked ? "Revoked and removed stored token." : "Removed stored token.",
  };
}

export function loginCommand(): Command {
  return new Command("login")
    .description("Log in from your browser and store a SkillMD token for publishing (--token stores one you already have)")
    .option("--token <token>", "store this token instead of logging in from the browser")
    .option("--api <url>", "registry API base to store")
    .option("--json", "machine-readable output")
    .action(async (opts: LoginFlags, cmd: Command) => {
      const flags: LoginFlags = { ...(cmd.parent?.opts() as LoginFlags | undefined), ...opts };
      const deps = defaultLoginDeps(flags);
      // Ctrl-C while waiting for the browser cancels the login cleanly (exit 0).
      // A second one is the usual way out of a stuck request.
      const ac = new AbortController();
      let presses = 0;
      const onSigint = () => { if (presses++ === 0) ac.abort(); else process.exit(130); };
      const waiting = Boolean(deps.interactive && !flags.token);
      if (waiting) process.on("SIGINT", onSigint);
      try {
        const r = await runLogin(flags, { ...deps, signal: ac.signal });
        console.log(r.output);
        process.exitCode = r.exitCode;
      } finally {
        if (waiting) process.off("SIGINT", onSigint);
      }
      // A request still in flight must not hold the terminal after Ctrl-C.
      if (ac.signal.aborted) process.exit(process.exitCode ?? 0);
    });
}

export function logoutCommand(): Command {
  return new Command("logout")
    .description("Revoke the stored SkillMD token on the server (best effort) and remove it")
    .option("--json", "machine-readable output")
    .action(async (opts: { json?: boolean }, cmd: Command) => {
      const r = await runLogout({ ...(cmd.parent?.opts() as LogoutFlags | undefined), ...opts });
      console.log(r.output);
      process.exitCode = r.exitCode;
    });
}
