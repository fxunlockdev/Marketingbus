import { createHash, randomBytes } from "node:crypto";

export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const databasePattern = /^mb_restore_[a-f0-9]{24}_(source|target)$/;
export function localRecoveryConfig(raw: string | undefined, container: string | undefined) {
  if (!raw || !container) throw Error("Set explicit REHEARSAL_DATABASE_URL and REHEARSAL_DOCKER_CONTAINER for a disposable local PostgreSQL server.");
  let url: URL;
  try { url = new URL(raw); } catch { throw Error("Invalid rehearsal database configuration."); }
  if (!["postgresql:", "postgres:"].includes(url.protocol) || !["127.0.0.1", "localhost"].includes(url.hostname)
    || !url.port || !url.username || url.search || url.hash || !/^\/[a-zA-Z0-9_]+$/.test(url.pathname))
    throw Error("Rehearsal requires a loopback PostgreSQL URL with an explicit port and no connection options.");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(container)) throw Error("Invalid local container identifier.");
  if (process.env.DOCKER_HOST || process.env.DOCKER_CONTEXT) throw Error("Unset Docker endpoint overrides for the local rehearsal.");
  return { url, container };
}
export function recoveryNames() {
  const id = randomBytes(12).toString("hex");
  return { source: `mb_restore_${id}_source`, target: `mb_restore_${id}_target` };
}
export function recoveryIdentifier(name: string) {
  if (!databasePattern.test(name)) throw Error("Refusing a non-rehearsal database identifier.");
  return `"${name}"`;
}
export function recoveryUrl(base: URL, name: string) {
  recoveryIdentifier(name);
  const url = new URL(base); url.pathname = `/${name}`; return url.toString();
}
export function assertLocalContainer(endpoint: string, ports: unknown, port: string) {
  if (!endpoint.trim().startsWith("unix:///")) throw Error("A local Unix-socket Docker context is required.");
  if (!Array.isArray(ports) || !ports.some(p => p && typeof p === "object" && p.HostPort === port
    && ["127.0.0.1", "0.0.0.0", "::"].includes(p.HostIp))) throw Error("Container port does not match the explicit loopback database URL.");
}
export function archiveDigest(bytes: Buffer) { return createHash("sha256").update(bytes).digest("hex"); }
export function verifyArchive(bytes: Buffer, digest: string) {
  if (bytes.length < 5 || bytes.length > MAX_ARCHIVE_BYTES || bytes.subarray(0, 5).toString() !== "PGDMP"
    || !/^[a-f0-9]{64}$/.test(digest) || archiveDigest(bytes) !== digest) throw Error("Rehearsal archive integrity check failed.");
}
// Used for subprocesses: no inherited provider keys, production DB, NODE_OPTIONS or execution flags.
export function isolatedEnvironment(extra: { DATABASE_URL?: string; PGPASSWORD?: string } = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    DATABASE_URL: extra.DATABASE_URL, PGPASSWORD: extra.PGPASSWORD,
    PAID_EXECUTION_ENABLED: "false", EMAIL_DELIVERY_ENABLED: "false", WEBSITE_EXTRACTION_ENABLED: "false",
    SOCIAL_EXECUTION_ENABLED: "false", MOTION_RENDERING_ENABLED: "false", BILLING_EXECUTION_ENABLED: "false",
    STRIPE_REFUNDS_ENABLED: "false" };
}
