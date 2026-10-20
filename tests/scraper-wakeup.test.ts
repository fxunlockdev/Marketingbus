import { expect, it, vi } from "vitest";
import { wakeScraper } from "../src/lib/knowledge/scraper-wakeup";
const base = new URL("http://scraper.railway.internal:11235/");
it("retries a cold start using only unauthenticated health GETs", async () => {
  const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 502 })).mockResolvedValueOnce(new Response(null, { status: 200 }));
  const pause = vi.fn(async () => {});
  await wakeScraper(base, transport, pause);
  expect(transport).toHaveBeenCalledTimes(2); expect(pause).toHaveBeenCalledWith(1000);
  for (const [url, options] of transport.mock.calls) {
    expect(String(url)).toBe(`${base}health`);
    expect(options).toMatchObject({ method: "GET", redirect: "error" });
    expect(options?.headers).toBeUndefined(); expect(options?.body).toBeUndefined();
  }
});
it("bounds repeated connection failures and hides internal errors", async () => {
  const transport = vi.fn<typeof fetch>().mockRejectedValue(Error("private diagnostic"));
  const pause = vi.fn(async () => {});
  await expect(wakeScraper(base, transport, pause)).rejects.toMatchObject({ code: "SCRAPER_UNAVAILABLE" });
  expect(transport).toHaveBeenCalledTimes(3); expect(pause).toHaveBeenCalledTimes(2);
});
it("does not retry unexpected health statuses", async () => {
  const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 403 }));
  const pause = vi.fn(async () => {});
  await expect(wakeScraper(base, transport, pause)).rejects.toMatchObject({ code: "SCRAPER_UNAVAILABLE" });
  expect(transport).toHaveBeenCalledTimes(1); expect(pause).not.toHaveBeenCalled();
});
