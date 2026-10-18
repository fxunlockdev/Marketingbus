import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { request as httpsRequest, RequestOptions } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createMediaDownloader, mediaUrl, publicMediaLookup } from "../src/lib/providers/media-download";

function transport({ status = 200, headers = { "content-type": "video/mp4" }, chunks = [Buffer.alloc(32)], broken = false }: { status?: number; headers?: Record<string, string>; chunks?: Buffer[]; broken?: boolean } = {}) {
  const res = Object.assign(new PassThrough(), { statusCode: status, headers }) as unknown as IncomingMessage;
  const req = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() }) as unknown as ClientRequest;
  const requester = vi.fn((url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    vi.mocked(req.end).mockImplementation((() => {
      queueMicrotask(() => {
        if (broken) { req.emit("error", Error("private-url-and-token")); return; }
        callback(res);
        if (res.destroyed) return;
        for (const chunk of chunks) if (!res.destroyed) res.push(chunk);
        if (!res.destroyed) res.push(null);
      }); return req;
    }) as typeof req.end);
    return req;
  });
  const dns = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
  return { requester, req, res, dns, download: createMediaDownloader(requester as unknown as typeof httpsRequest, dns) };
}
describe("provider media network boundary", () => {
  it.each([
    "http://cdn.example.com/video.mp4", "https://cdn.example.com:444/video.mp4", "https://user:secret@cdn.example.com/video.mp4", "https://cdn.example.com/video.mp4#fragment",
    "https://cdn.example.com.attacker.com/video.mp4", "https://attacker.example/video.mp4", "https://127.0.0.1/video.mp4", "https://2130706433/video.mp4", "https://[::1]/video.mp4", "https://169.254.169.254/latest/meta-data", "https://cdn.example.com\\@attacker.com/file", "https://cdn.example.com/\nfile",
  ])("rejects unsafe download URL %s", async url => {
    const t = transport(); await expect(t.download(url, ["cdn.example.com"], AbortSignal.timeout(1000))).rejects.toThrow("could not be retrieved safely"); expect(t.requester).not.toHaveBeenCalled();
  });
  it("uses a fresh TLS connection, pinned public DNS and no authorization/cookies", async () => {
    const t = transport();
    expect(await t.download("https://cdn.example.com/file.mp4?signature=private", ["cdn.example.com"], AbortSignal.timeout(1000))).toHaveLength(32);
    const options = t.requester.mock.calls[0][1];
    expect(options).toMatchObject({ method: "GET", agent: false, rejectUnauthorized: true, minVersion: "TLSv1.2", headers: { Accept: "video/mp4", "Accept-Encoding": "identity" } });
    expect(Object.keys(options.headers!)).toEqual(["Accept", "Accept-Encoding"]);
    expect(options.lookup).toBeTypeOf("function"); expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(t.requester).toHaveBeenCalledOnce();
  });
  it.each([301, 302, 307, 308, 401, 403, 404, 429, 500])("never follows or retries HTTP %s", async status => {
    const t = transport({ status, headers: { "content-type": "video/mp4", location: "http://127.0.0.1/private" } });
    await expect(t.download("https://cdn.example.com/file", ["cdn.example.com"], AbortSignal.timeout(1000))).rejects.toThrow("could not be retrieved safely");
    expect(t.requester).toHaveBeenCalledOnce(); expect(t.req.destroy).toHaveBeenCalledOnce();
  });
  it.each(["mime", "encoding", "declared-large", "declared-small", "malformed-length", "truncated", "oversized-chunk", "empty"])("rejects %s media responses", async kind => {
    const headers: Record<string, string> = { "content-type": "video/mp4" }; let chunks = [Buffer.alloc(32)];
    if (kind === "mime") headers["content-type"] = "text/html";
    if (kind === "encoding") headers["content-encoding"] = "gzip";
    if (kind === "declared-large") headers["content-length"] = String(20 * 1024 * 1024 + 1);
    if (kind === "declared-small") headers["content-length"] = "16";
    if (kind === "malformed-length") headers["content-length"] = "32garbage";
    if (kind === "truncated") headers["content-length"] = "64";
    if (kind === "oversized-chunk") chunks = [Buffer.alloc(20 * 1024 * 1024 + 1)];
    if (kind === "empty") chunks = [];
    const t = transport({ headers, chunks });
    await expect(t.download("https://cdn.example.com/file", ["cdn.example.com"], AbortSignal.timeout(1000))).rejects.toThrow("could not be retrieved safely");
  });
  it("accepts bounded chunked/octet-stream media without assuming the supplier's length", async () => {
    const t = transport({ headers: { "content-type": "application/octet-stream" }, chunks: [Buffer.alloc(16), Buffer.alloc(16)] });
    expect(await t.download("https://cdn.example.com/file", ["cdn.example.com"], AbortSignal.timeout(1000))).toHaveLength(32);
  });
  it("sanitizes transport errors and honors abort before connecting", async () => {
    const t = transport({ broken: true });
    await expect(t.download("https://cdn.example.com/file", ["cdn.example.com"], AbortSignal.timeout(1000))).rejects.toThrow("could not be retrieved safely");
    const before = transport(); await expect(before.download("https://cdn.example.com/file", ["cdn.example.com"], AbortSignal.abort())).rejects.toThrow("could not be retrieved safely"); expect(before.requester).not.toHaveBeenCalled();
  });
  async function lookup(records: { address: string; family: number }[], all = false, signal = AbortSignal.timeout(1000)) {
    const resolve = vi.fn(async () => records), fn = publicMediaLookup(resolve, signal);
    const result = await new Promise<{ address: unknown; family?: number }>((resolveResult, reject) => fn("cdn.example.com", { all }, (error, address, family) => error ? reject(error) : resolveResult({ address, family })));
    expect(resolve).toHaveBeenCalledExactlyOnceWith("cdn.example.com"); return result;
  }
  it("returns only the already-validated DNS answers used by the socket", async () => {
    const records = [{ address: "93.184.216.34", family: 4 }, { address: "2606:4700:4700::1111", family: 6 }];
    expect(await lookup(records)).toEqual({ address: records[0].address, family: 4 });
    expect((await lookup(records, true)).address).toEqual(records);
  });
  it("blocks a private answer through the actual Node HTTPS socket lookup before connection", async () => {
    const dns = vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]);
    const download = createMediaDownloader(undefined, dns);
    await expect(download("https://cdn.example.com/file", ["cdn.example.com"], AbortSignal.timeout(1000))).rejects.toThrow("could not be retrieved safely");
    expect(dns).toHaveBeenCalledExactlyOnceWith("cdn.example.com");
  });
  it.each(["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::ffff:127.0.0.1", "fd00::1", "fe80::1", "invalid"])("rejects private/reserved DNS answer %s, including mixed answer sets", async address => {
    await expect(lookup([{ address: "93.184.216.34", family: 4 }, { address, family: address.includes(":") ? 6 : 4 }])).rejects.toThrow("could not be retrieved safely");
  });
  it("rejects missing, excessive, mismatched-family and canceled DNS answers", async () => {
    for (const records of [[], Array.from({ length: 33 }, () => ({ address: "93.184.216.34", family: 4 })), [{ address: "93.184.216.34", family: 6 }]]) await expect(lookup(records)).rejects.toThrow();
    await expect(lookup([{ address: "93.184.216.34", family: 4 }], false, AbortSignal.abort())).rejects.toThrow();
  });
  it("keeps signed query parameters intact but never accepts fragments", () => {
    expect(mediaUrl("https://cdn.example.com/file?signature=a%2Fb", ["cdn.example.com"]).search).toBe("?signature=a%2Fb");
  });
});
