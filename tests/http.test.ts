import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { api, AppError } from "../src/lib/http";
describe("private API response caching", () => {
  it("marks authentication failures no-store", async () => {
    const response = await api(async () => { throw new AppError(401, "Please sign in."); });
    expect(response.status).toBe(401); expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("marks validation failures no-store", async () => {
    const response = await api(async () => z.string().parse(2));
    expect(response.status).toBe(400); expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("sanitizes internal failures and prevents caching", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await api(async () => { throw new Error("private database credential"); });
      expect(response.status).toBe(500); expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).not.toContain("credential"); expect(JSON.stringify(log.mock.calls)).not.toContain("credential");
    } finally { log.mockRestore(); }
  });
});
