import { createServer } from "node:http";
import { lookup } from "node:dns/promises";
import { connect as connectSocket, isIP } from "node:net";
import { timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import ipaddr from "ipaddr.js";

// Dedicated to the scraper browser, not a general-purpose customer proxy.
// The browser must have no alternate network path in the deployment topology.
export function publicHostname(authority) {
  if (typeof authority !== "string" || !/^(?:\[[\da-fA-F:.]+\]|[a-zA-Z\d.-]+):443$/.test(authority)) throw Error("restricted");
  const url = new URL(`https://${authority}`);
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!host.includes(".") && !isIP(host)) throw Error("restricted");
  if (["localhost", "local", "internal", "home.arpa"].some(suffix => host === suffix || host.endsWith(`.${suffix}`))) throw Error("restricted");
  if (isIP(host) && ipaddr.process(host).range() !== "unicast") throw Error("restricted");
  return host;
}

function bounded(promise, milliseconds) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("timeout")), milliseconds); })])
    .finally(() => clearTimeout(timer));
}

/** @param {{password?: string, resolve?: (host: string, options: {all: true, verbatim: true}) => Promise<Array<{address: string, family: number}>>, connect?: (options: {host: string, port: number, family: number}) => import('node:net').Socket, timeoutMs?: number, dnsTimeoutMs?: number, maxTunnels?: number, maxBytes?: number}} options */
export function createPublicEgressProxy({ password, resolve = lookup, connect = connectSocket,
  timeoutMs = 45000, dnsTimeoutMs = 5000, maxTunnels = 16, maxBytes = 16 * 1024 * 1024 } = {}) {
  if (typeof password !== "string" || !/^[\x21-\x7e]{24,256}$/.test(password)) throw Error("A private proxy credential of 24–256 printable characters is required");
  for (const value of [timeoutMs, dnsTimeoutMs, maxTunnels, maxBytes]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw Error("Invalid proxy bounds");
  }
  const credential = Buffer.from(`Basic ${Buffer.from(`scraper:${password}`).toString("base64")}`);
  const sockets = new Set();
  let active = 0;
  let resolving = 0;
  let stopping = false;
  const server = createServer({ maxHeaderSize: 8192, headersTimeout: 10000, requestTimeout: 10000 }, (_request, response) => {
    response.writeHead(403, { Connection: "close", "Content-Type": "text/plain" }); response.end("HTTPS tunnels only\n");
  });
  server.maxConnections = maxTunnels + 16;
  server.on("connection", socket => {
    sockets.add(socket);
    socket.setTimeout(10000, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("upgrade", (_request, socket) => socket.destroy());
  server.on("connect", async (request, client, head) => {
    const deny = status => { if (!client.destroyed) client.end(`HTTP/1.1 ${status}\r\n${status.startsWith("407") ? 'Proxy-Authenticate: Basic realm="scraper"\r\n' : ""}Connection: close\r\nContent-Length: 0\r\n\r\n`); };
    const supplied = Buffer.from(request.headers["proxy-authorization"] ?? "");
    if (supplied.length !== credential.length || !timingSafeEqual(supplied, credential)) { deny("407 Proxy Authentication Required"); return; }
    if (head.length > maxBytes) { deny("413 Content Too Large"); return; }
    if (stopping || active >= maxTunnels || resolving >= maxTunnels) { deny("503 Service Unavailable"); return; }
    active += 1;
    let upstream;
    let released = false;
    const release = () => { if (!released) { released = true; active -= 1; } };
    const end = () => { upstream?.destroy(); client.destroy(); release(); };
    let deadline;
    try {
      const host = publicHostname(request.url);
      // Resolve all answers once, reject mixed public/private answers, then dial
      // the validated numeric IP. No second resolver call at connect time.
      let records;
      if (isIP(host)) records = [{ address: host, family: isIP(host) }];
      else {
        resolving += 1;
        // A timeout cannot cancel OS getaddrinfo. Retain a separate admission
        // slot until the underlying lookup settles, preventing an unbounded
        // backlog of timed-out resolver work.
        const pending = Promise.resolve().then(() => resolve(host, { all: true, verbatim: true })).finally(() => { resolving -= 1; });
        records = await bounded(pending, dnsTimeoutMs);
      }
      if (!Array.isArray(records) || !records.length || records.some(record => !isIP(record.address)
        || ipaddr.process(record.address).range() !== "unicast" || isIP(record.address) !== record.family)) throw Error("restricted");
      if (client.destroyed || stopping) { end(); return; }
      const record = records.find(record => record.family === 4) ?? records[0];
      client.setTimeout(timeoutMs, end);
      deadline = setTimeout(end, timeoutMs);
      upstream = connect({ host: record.address, port: 443, family: record.family });
      sockets.add(upstream);
      let bytes = head.length;
      const count = chunk => { bytes += chunk.length; if (bytes > maxBytes) end(); };
      client.on("data", count); upstream.on("data", count);
      client.once("error", end); upstream.once("error", end);
      client.once("close", end);
      upstream.once("close", () => { sockets.delete(upstream); clearTimeout(deadline); end(); });
      upstream.once("connect", () => {
        if (client.destroyed || bytes > maxBytes) { end(); return; }
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client);
      });
    } catch {
      // Do not reveal DNS errors, destination addresses, credentials or bodies.
      clearTimeout(deadline); upstream?.destroy(); release(); deny("403 Forbidden");
    }
  });
  return Object.assign(server, { shutdown: () => new Promise((done, reject) => {
    stopping = true;
    for (const socket of sockets) socket.destroy();
    server.close(error => error ? reject(error) : done());
  }) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createPublicEgressProxy({ password: process.env.SCRAPER_PROXY_PASSWORD });
  const port = Number(process.env.SCRAPER_PROXY_PORT ?? 8899);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error("Invalid proxy port");
  server.listen(port, process.env.SCRAPER_PROXY_HOST ?? "127.0.0.1", () => console.log("Private scraper egress proxy ready"));
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => { void server.shutdown().catch(() => { process.exitCode = 1; }); });
}
