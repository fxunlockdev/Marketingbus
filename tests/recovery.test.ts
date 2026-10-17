import { afterEach, describe, expect, it, vi } from "vitest";
import { archiveDigest, assertLocalContainer, isolatedEnvironment, localRecoveryConfig, recoveryIdentifier, recoveryNames, recoveryUrl, verifyArchive } from "../scripts/recovery/safety";
import { assertSnapshot, tableIdentifier, type RecoverySnapshot } from "../scripts/recovery/snapshot";
afterEach(() => vi.unstubAllEnvs());
const local = "postgresql://fixture:local-only@127.0.0.1:55439/fixture";
describe("isolated recovery rehearsal guards", () => {
  it("requires explicit configuration and never falls back to DATABASE_URL", () => {
    vi.stubEnv("DATABASE_URL", "postgresql://secret@production.example/prod");
    expect(() => localRecoveryConfig(undefined, "fixture-db")).toThrow("explicit");
    expect(() => localRecoveryConfig(local, undefined)).toThrow("explicit");
  });
  it.each(["postgresql://u:p@production.example:5432/db", "postgresql://u:p@10.0.0.2:5432/db", "postgresql://u:p@127.0.0.1/db", "postgresql://u:p@localhost:5432/db?host=remote", "postgresql://u:p@localhost:5432/db#bad", "https://u:p@localhost:5432/db", "postgresql://u:p@127.0.0.1:5432/db%2Fother"])("refuses unsafe connection %s", raw => {
    expect(() => localRecoveryConfig(raw, "fixture-db")).toThrow();
  });
  it("validates container identifiers and Docker endpoint overrides", () => {
    expect(() => localRecoveryConfig(local, "--privileged")).toThrow("container");
    expect(() => localRecoveryConfig(local, "fixture;echo")).toThrow("container");
    vi.stubEnv("DOCKER_HOST", "tcp://remote:2375"); expect(() => localRecoveryConfig(local, "fixture")).toThrow("overrides");
  });
  it("only accepts the matching local container port", () => {
    const ports = [{ HostIp: "127.0.0.1", HostPort: "55439" }];
    expect(() => assertLocalContainer("unix:///local/docker.sock", ports, "55439")).not.toThrow();
    expect(() => assertLocalContainer("ssh://elsewhere", ports, "55439")).toThrow("local");
    expect(() => assertLocalContainer("unix:///local/docker.sock", ports, "5432")).toThrow("port");
    expect(() => assertLocalContainer("unix:///local/docker.sock", null, "55439")).toThrow("port");
  });
  it("creates collision-resistant names and only allows generated target identifiers", () => {
    const first = recoveryNames(), second = recoveryNames(); expect(first).not.toEqual(second);
    expect(recoveryIdentifier(first.source)).toBe(`"${first.source}"`);
    expect(new URL(recoveryUrl(new URL(local), first.target)).pathname).toBe(`/${first.target}`);
    for (const bad of ["postgres", "railway", "marketingbus", 'mb_restore_x_target";DROP DATABASE postgres', "mb_restore_123_source"])
      expect(() => recoveryIdentifier(bad)).toThrow("non-rehearsal");
  });
  it("rejects corrupt, non-custom and empty archives before restore", () => {
    const archive = Buffer.from("PGDMPsynthetic-format-for-hash-test"), digest = archiveDigest(archive);
    expect(() => verifyArchive(archive, digest)).not.toThrow();
    expect(() => verifyArchive(Buffer.from("PGDMPtampered"), digest)).toThrow("integrity");
    expect(() => verifyArchive(Buffer.from("SELECT 1"), archiveDigest(Buffer.from("SELECT 1")))).toThrow("integrity");
    expect(() => verifyArchive(Buffer.alloc(0), digest)).toThrow("integrity");
  });
  it("strips provider keys, production URLs and Node process injection from child environments", () => {
    vi.stubEnv("OPENAI_API_KEY", "must-not-inherit"); vi.stubEnv("DATABASE_URL", "must-not-inherit");
    vi.stubEnv("NODE_OPTIONS", "must-not-inherit"); vi.stubEnv("PAID_EXECUTION_ENABLED", "true");
    const env = isolatedEnvironment({ DATABASE_URL: local });
    expect(env.DATABASE_URL).toBe(local); expect(env.OPENAI_API_KEY).toBeUndefined(); expect(env.NODE_OPTIONS).toBeUndefined();
    for (const key of ["PAID_EXECUTION_ENABLED", "EMAIL_DELIVERY_ENABLED", "WEBSITE_EXTRACTION_ENABLED", "SOCIAL_EXECUTION_ENABLED", "MOTION_RENDERING_ENABLED", "BILLING_EXECUTION_ENABLED", "STRIPE_REFUNDS_ENABLED"]) expect(env[key]).toBe("false");
  });
  it("rejects unsupported catalog identifiers", () => {
    expect(tableIdentifier("_prisma_migrations")).toBe('public."_prisma_migrations"');
    expect(() => tableIdentifier('User"; DELETE FROM "User')).toThrow();
    expect(() => tableIdentifier("x".repeat(64))).toThrow();
  });
  it("detects missing tables, changed row count, changed content and changed schema", () => {
    const baseline: RecoverySnapshot = { schemaHash: "schema", tables: [{ name: "Wallet", count: 2, hash: "rows" }] };
    expect(() => assertSnapshot(baseline, structuredClone(baseline))).not.toThrow();
    for (const candidate of [{ ...baseline, tables: [] }, { ...baseline, schemaHash: "changed" },
      { ...baseline, tables: [{ name: "Wallet", count: 1, hash: "rows" }] }, { ...baseline, tables: [{ name: "Wallet", count: 2, hash: "changed" }] }])
      expect(() => assertSnapshot(baseline, candidate)).toThrow("fingerprints");
  });
});
