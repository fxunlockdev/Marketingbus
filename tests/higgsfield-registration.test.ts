import { afterEach, describe, expect, it, vi } from "vitest";
import { configuredShotAdapters, selectShotRoute, shotConfigurationHash } from "../src/lib/video/generation-contracts";
import { createHiggsfieldTransport } from "../src/lib/providers/higgsfield";

function configuration() {
  const settings = { keyId: "fixture-key-id", secret: "fixture-private-secret", verifiedUntil: new Date(Date.now() + 86400000).toISOString(), outputHosts: ["cdn.example.com"] };
  vi.stubEnv("HIGGSFIELD_API_KEY", settings.keyId); vi.stubEnv("HIGGSFIELD_API_SECRET", settings.secret);
  vi.stubEnv("HIGGSFIELD_VIDEO_ENABLED", "true"); vi.stubEnv("HIGGSFIELD_EXPENSE_POLICY", "account-quote-v1");
  vi.stubEnv("HIGGSFIELD_VERIFIED_UNTIL", settings.verifiedUntil); vi.stubEnv("HIGGSFIELD_OUTPUT_HOSTS_JSON", JSON.stringify(settings.outputHosts));
  const accountId = createHiggsfieldTransport(settings).credentialFingerprint;
  const rate = { provider: "higgsfield", accountId, adapterVersion: "higgsfield-account-quote-v1", model: "seedance-2.5-text", durationMs: 5000, ceilingMicros: 100000, verifiedUntil: settings.verifiedUntil, expensePolicy: "account-quote-v1" };
  vi.stubEnv("VIDEO_RATE_CARD_JSON", JSON.stringify([rate]));
  return { settings, rate };
}
describe("explicit Higgsfield delivery registration", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
  it("registers the concrete adapter without calling any network during setup, status or routing", () => {
    const network = vi.fn(() => { throw Error("No network"); }); vi.stubGlobal("fetch", network);
    const { rate } = configuration(), adapters = configuredShotAdapters();
    expect(adapters).toHaveLength(1); expect(adapters[0]).toMatchObject({ id: "higgsfield", accountId: rate.accountId, version: rate.adapterVersion });
    expect(selectShotRoute(5000, adapters)).toMatchObject({ ...rate, credits: 10 });
    expect(network).not.toHaveBeenCalled();
  });
  it("does not activate with credentials alone or a truthy-looking nonliteral flag", () => {
    configuration();
    for (const enabled of ["", "false", "1", "TRUE", "yes"]) { vi.stubEnv("HIGGSFIELD_VIDEO_ENABLED", enabled); expect(configuredShotAdapters()).toEqual([]); }
  });
  it.each([
    ["HIGGSFIELD_EXPENSE_POLICY", ""], ["HIGGSFIELD_EXPENSE_POLICY", "final"],
    ["HIGGSFIELD_API_KEY", ""], ["HIGGSFIELD_API_SECRET", ""],
    ["HIGGSFIELD_VERIFIED_UNTIL", "2000-01-01T00:00:00Z"], ["HIGGSFIELD_VERIFIED_UNTIL", "2099-01-01T00:00:00Z"],
    ["HIGGSFIELD_OUTPUT_HOSTS_JSON", "[]"], ["HIGGSFIELD_OUTPUT_HOSTS_JSON", '["*.example.com"]'],
    ["HIGGSFIELD_OUTPUT_HOSTS_JSON", '["127.0.0.1"]'], ["HIGGSFIELD_OUTPUT_HOSTS_JSON", "bad-json"],
  ])("fails closed for invalid %s=%s without disclosing configuration", (key, value) => {
    const { settings } = configuration(); vi.stubEnv(key, value);
    expect(() => configuredShotAdapters()).toThrow("operator configuration");
    try { configuredShotAdapters(); } catch (error) { expect(String(error)).not.toContain(settings.secret); expect(String(error)).not.toContain(settings.keyId); }
  });
  it.each(["account", "version", "model", "duration", "policy", "expiry"])("excludes unsupported %s rates before any quote or reservation", reason => {
    const { rate } = configuration(), adapters = configuredShotAdapters();
    const invalid = { ...rate };
    if (reason === "account") invalid.accountId = "other-account";
    if (reason === "version") invalid.adapterVersion = "other-version";
    if (reason === "model") invalid.model = "unverified-model";
    if (reason === "duration") invalid.durationMs = 5250;
    if (reason === "policy") invalid.expensePolicy = "final";
    if (reason === "expiry") invalid.verifiedUntil = new Date(Date.now() + 2 * 86400000).toISOString();
    vi.stubEnv("VIDEO_RATE_CARD_JSON", JSON.stringify([invalid]));
    expect(() => selectShotRoute(5000, adapters)).toThrow("verified provider");
  });
  it.each(["HIGGSFIELD_API_KEY", "HIGGSFIELD_API_SECRET", "HIGGSFIELD_VERIFIED_UNTIL", "HIGGSFIELD_OUTPUT_HOSTS_JSON", "HIGGSFIELD_EXPENSE_POLICY", "HIGGSFIELD_VIDEO_ENABLED"])("pins %s into worker/quote identity without exposing its value", key => {
    const { settings } = configuration(), before = shotConfigurationHash(); vi.stubEnv(key, "changed");
    expect(shotConfigurationHash()).not.toBe(before); expect(shotConfigurationHash()).toMatch(/^[a-f0-9]{64}$/);
    expect(before).not.toContain(settings.secret);
  });
});
