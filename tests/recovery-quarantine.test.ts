import { afterEach, describe, expect, it, vi } from "vitest";
import { recoveryQuarantined } from "../src/lib/recovery-quarantine";
import { proxy } from "../src/proxy";

afterEach(() => vi.unstubAllEnvs());
describe("recovery deployment gate", () => {
  it.each(["true", "TRUE", "1", "", " false", "false ", "False", "typo"])("fails closed for configured value %j", async value => {
    vi.stubEnv("RECOVERY_QUARANTINE", value);
    expect(recoveryQuarantined()).toBe(true);
    const result = proxy();
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ status: "unavailable", message: "Service temporarily unavailable." });
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.headers.get("referrer-policy")).toBe("no-referrer");
    expect(result.headers.has("set-cookie")).toBe(false);
    expect(result.headers.has("location")).toBe(false);
  });
  it.each([undefined, "false"])("preserves normal routing only for %j", value => {
    vi.stubEnv("RECOVERY_QUARANTINE", value);
    expect(recoveryQuarantined()).toBe(false);
    expect(proxy().headers.get("x-middleware-next")).toBe("1");
  });
});
