// The two failures a registry install can end in. They live apart from api.ts so
// the retry helper can throw one without a circular import; api.ts re-exports
// both, so `import { RegistryError } from "./api.js"` keeps working everywhere.

/** Thrown when a downloaded file's bytes don't match the registry's recorded
 *  sha256. Tagged so the installer can hard-block instead of silently falling
 *  back to an unverified source. */
export class IntegrityError extends Error {
  readonly integrity = true;
  constructor(message: string) {
    super(message);
    this.name = "IntegrityError";
  }
}

/** Thrown when a registry request fails. `status` is set for HTTP error
 *  responses and absent for network-level failures (DNS, connection refused,
 *  proxy CONNECT denial). Callers use it to tell "the skill isn't in the
 *  registry" (404 — falling back to GitHub is correct) apart from "the
 *  registry can't be reached from here" (egress-blocked sandboxes, proxies —
 *  falling back would bury the real cause under a confusing GitHub 404).
 *
 *  `retryAfterSec` is the wait the server asked for, when it asked for one. */
export class RegistryError extends Error {
  constructor(message: string, readonly status?: number, readonly retryAfterSec?: number) {
    super(message);
    this.name = "RegistryError";
  }
}
