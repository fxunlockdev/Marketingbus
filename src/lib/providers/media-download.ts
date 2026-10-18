import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import ipaddr from "ipaddr.js";

const failure = () => Error("Provider media could not be retrieved safely.");
export type MediaDns = (host: string) => Promise<{ address: string; family: number }[]>;
export function mediaHost(host: string) {
  if (host.length > 253 || host !== host.toLowerCase() || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) || /\.(?:local|localhost|internal|test|invalid|example)$/.test(host) || ipaddr.isValid(host)) throw failure();
  return host;
}
export function mediaUrl(raw: string, allowedHosts: readonly string[]) {
  if (raw.length > 4096 || /[\u0000-\u0020\u007f\\]/.test(raw)) throw failure();
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash || !allowedHosts.includes(mediaHost(url.hostname))) throw failure();
  return url;
}
// DNS validation happens inside the socket's lookup, not as a separate fetch
// preflight that would permit another resolution/rebinding before connection.
export function publicMediaLookup(resolve: MediaDns, signal: AbortSignal): LookupFunction {
  return (host, options, callback) => {
    void resolve(host).then(records => {
      signal.throwIfAborted();
      if (!records.length || records.length > 32 || records.some(r => ![4, 6].includes(r.family) || !ipaddr.isValid(r.address) || ipaddr.process(r.address).range() !== "unicast" || ipaddr.parse(r.address).kind() !== (r.family === 4 ? "ipv4" : "ipv6"))) throw failure();
      if (options.all) callback(null, records);
      else callback(null, records[0].address, records[0].family);
    }).catch(() => callback(failure(), "", 0));
  };
}
export type MediaDownload = (url: string, hosts: readonly string[], signal: AbortSignal) => Promise<Uint8Array>;
export function createMediaDownloader(requester: typeof httpsRequest = httpsRequest, resolve: MediaDns = host => lookup(host, { all: true })): MediaDownload {
  return async (raw, allowedHosts, parent) => {
    try {
    const url = mediaUrl(raw, allowedHosts), signal = AbortSignal.any([parent, AbortSignal.timeout(20000)]);
    signal.throwIfAborted();
    return await new Promise<Buffer>((resolveBytes, reject) => {
      let done = false;
      const fail = () => { if (!done) { done = true; reject(failure()); } };
      // No provider authorization, cookies, reusable agent, redirects or retries.
      const req = requester(url, { method: "GET", agent: false, signal, rejectUnauthorized: true, minVersion: "TLSv1.2", lookup: publicMediaLookup(resolve, signal), headers: { Accept: "video/mp4", "Accept-Encoding": "identity" } }, res => {
        const maxBytes = 20 * 1024 * 1024;
        const declared = res.headers["content-length"], encoding = res.headers["content-encoding"];
        if (res.statusCode !== 200 || !/^(?:video\/mp4|application\/octet-stream)(?:\s*;|$)/i.test(res.headers["content-type"] || "") || encoding && encoding !== "identity" || declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) < 16 || Number(declared) > maxBytes)) {
          fail(); res.destroy(); req.destroy(); return;
        }
        let length = 0; const chunks: Buffer[] = [];
        res.on("data", chunk => {
          length += chunk.length;
          if (length > maxBytes || signal.aborted) { fail(); res.destroy(); req.destroy(); return; }
          chunks.push(Buffer.from(chunk));
        });
        res.on("error", fail); res.on("aborted", fail);
        res.on("end", () => {
          if (done) return;
          if (signal.aborted || length < 16 || declared !== undefined && Number(declared) !== length) { fail(); return; }
          done = true; resolveBytes(Buffer.concat(chunks));
        });
        res.on("close", () => { if (!done) fail(); });
      });
      req.on("error", fail);
      req.end();
    });
    } catch { throw failure(); }
  };
}
export const downloadProviderMedia = createMediaDownloader();
