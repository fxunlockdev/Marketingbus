import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { publicHostname } from "./public-egress-proxy.mjs";

export function browserTarget(input) {
  if (typeof input !== "string" || input.length > 2048) throw Error("restricted");
  const url = new URL(input);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) throw Error("restricted");
  publicHostname(`${url.hostname}:443`);
  url.hash = "";
  return url;
}

// No browser-side DNS preflight: the isolated browser cannot resolve external
// hosts. The mandatory public-egress proxy resolves and pins every connection.
// Production deployment must prevent bypassing that proxy at the network layer.
export function createBrowserService({ token, proxyServer, proxyPassword, launch }) {
  if (!/^[\x21-\x7e]{24,256}$/.test(token ?? "") || !/^[\x21-\x7e]{24,256}$/.test(proxyPassword ?? "")) throw Error("Private browser and proxy credentials are required");
  const proxy = new URL(proxyServer);
  if (proxy.protocol !== "http:" || proxy.username || proxy.password || proxy.pathname !== "/" || proxy.search || proxy.hash) throw Error("Invalid private proxy endpoint");
  const auth = Buffer.from(`Bearer ${token}`);
  let busy = false;
  let stopping = false;
  let browser;
  const sockets = new Set();
  const send = (response, status, value) => {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, { "Content-Type": "application/json", Connection: "close", "Cache-Control": "no-store" });
    response.end(JSON.stringify(value));
  };
  const server = createServer({ maxHeaderSize: 8192, headersTimeout: 10000, requestTimeout: 10000 }, async (request, response) => {
    const supplied = Buffer.from(request.headers.authorization ?? "");
    if (supplied.length !== auth.length || !timingSafeEqual(supplied, auth)) { send(response, 401, { error: "Authentication required" }); return; }
    if (request.method === "GET" && request.url === "/health") { send(response, stopping ? 503 : 200, { status: stopping ? "stopping" : "ready", busy }); return; }
    if (request.method !== "POST" || request.url !== "/scrape") { send(response, 404, { error: "Not found" }); return; }
    if (busy || stopping) { send(response, 503, { error: "Browser busy" }); return; }
    if (!request.headers["content-type"]?.startsWith("application/json") || Number(request.headers["content-length"]) > 4096) {
      send(response, 400, { error: "Invalid request" }); return;
    }
    busy = true;
    let timer;
    let timedOut = false;
    let context;
    let page;
    let navigationBlocked = false;
    let cancelled = false;
    let outcome;
    const reply = (status, value) => { outcome = { status, value }; };
    response.once("close", () => {
      if (!response.writableEnded) { cancelled = true; void browser?.close().catch(() => {}); }
    });
    try {
      const parts = []; let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 4096) { reply(413, { error: "Request too large" }); return; }
        parts.push(chunk);
      }
      let input; let target; let timeout;
      try {
        input = JSON.parse(Buffer.concat(parts).toString("utf8")); target = browserTarget(input.url);
        timeout = input.timeout ?? 30000;
        if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 30000 || input.skip_tls_verification
          || (input.headers && Object.keys(input.headers).length) || (input.wait_after_load && input.wait_after_load !== 0)
          || Object.keys(input).some(key => !["url", "timeout", "headers", "wait_after_load", "skip_tls_verification"].includes(key))) throw Error("invalid");
      } catch { reply(400, { error: "Invalid or restricted request" }); return; }
      timer = setTimeout(() => { timedOut = true; void browser?.close().catch(() => {}); }, timeout);
      browser = await launch({ headless: true, timeout, proxy: { server: proxy.href, username: "scraper", password: proxyPassword },
        args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-quic", "--proxy-bypass-list=<-loopback>", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"] });
      if (timedOut || stopping || cancelled) throw Error("cancelled");
      context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false, ignoreHTTPSErrors: false });
      await context.route("**/*", async route => {
        const req = route.request();
        try {
          const destination = browserTarget(req.url());
          const mainNavigation = req.isNavigationRequest() && req.frame() === page?.mainFrame();
          if (mainNavigation && destination.origin !== target.origin) { navigationBlocked = true; throw Error("redirect"); }
          if (!["GET", "HEAD"].includes(req.method()) || ["image", "media", "font"].includes(req.resourceType())) throw Error("not needed");
          await route.continue();
        } catch { await route.abort().catch(() => {}); }
      });
      await context.routeWebSocket("**/*", socket => socket.close());
      context.on("page", opened => { if (page && opened !== page) void opened.close().catch(() => {}); });
      page = await context.newPage();
      const result = await page.goto(target.href, { waitUntil: "domcontentloaded", timeout });
      await page.waitForLoadState("networkidle", { timeout: Math.min(timeout, 2000) }).catch(() => {});
      const final = browserTarget(page.url());
      if (navigationBlocked || final.origin !== target.origin) throw Error("redirect");
      const content = await page.content();
      if (Buffer.byteLength(content) > 2 * 1024 * 1024) { reply(413, { error: "Page too large" }); return; }
      if (timedOut || stopping || cancelled) throw Error("cancelled");
      reply(200, { content, pageStatusCode: result?.status() ?? 502, contentType: "text/html", url: final.href });
    } catch {
      reply(timedOut ? 504 : 502, { error: timedOut ? "Browser timed out" : "Page unavailable" });
    } finally {
      clearTimeout(timer);
      await context?.close().catch(() => {});
      await browser?.close().catch(() => {});
      browser = undefined; busy = false;
      if (outcome) send(response, outcome.status, outcome.value);
    }
  });
  server.maxConnections = 8;
  server.on("connection", socket => {
    sockets.add(socket); socket.setTimeout(35000, () => socket.destroy());
    socket.on("error", () => socket.destroy()); socket.once("close", () => sockets.delete(socket));
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("upgrade", (_request, socket) => socket.destroy());
  server.on("connect", (_request, socket) => socket.destroy());
  return Object.assign(server, { shutdown: async () => {
    stopping = true; await browser?.close().catch(() => {});
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { chromium } = await import("playwright");
  const server = createBrowserService({ token: process.env.SCRAPER_BROWSER_TOKEN, proxyServer: process.env.SCRAPER_PROXY_URL,
    proxyPassword: process.env.SCRAPER_PROXY_PASSWORD, launch: options => chromium.launch(options) });
  const port = Number(process.env.SCRAPER_BROWSER_PORT ?? 3003);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error("Invalid browser port");
  server.listen(port, process.env.SCRAPER_BROWSER_HOST ?? "127.0.0.1", () => console.log("Private on-demand browser ready"));
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => { void server.shutdown().catch(() => { process.exitCode = 1; }); });
}
