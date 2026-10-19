import { createServer } from "node:http";
import { fork } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { browserTarget } from "./browser-service.mjs";

export function coreEnvironment({ coreRoot, browserUrl, browserToken, redisUrl }) {
  if (typeof coreRoot !== "string" || !coreRoot.startsWith("/") || !/^[\x21-\x7e]{24,256}$/.test(browserToken ?? "")) throw Error("Invalid private engine configuration");
  for (const [value, protocol] of [[browserUrl, "http:"], [redisUrl, "redis:"]]) {
    const url = new URL(value);
    if (url.protocol !== protocol || (!url.hostname.endsWith(".internal") && url.hostname.includes(".") && url.hostname !== "127.0.0.1")) throw Error("Private engine dependencies required");
    if (url.hash || url.search || (protocol === "http:" && (url.username || url.password || url.pathname !== "/scrape"))) throw Error("Invalid dependency endpoint");
  }
  return { NODE_ENV: "production", ENV: "local", USE_DB_AUTHENTICATION: "false", ALLOW_LOCAL_WEBHOOKS: "false", LOGGING_LEVEL: "error", MARKETINGBUS_PRIVATE_INTAKE: "true",
    FIRECRAWL_CORE_ROOT: coreRoot, PLAYWRIGHT_MICROSERVICE_URL: browserUrl, PLAYWRIGHT_MICROSERVICE_TOKEN: browserToken,
    REDIS_URL: redisUrl, REDIS_RATE_LIMIT_URL: redisUrl };
}

export function runCoreJob(input, { environment, entry = fileURLToPath(new URL("./core-job.cjs", import.meta.url)), spawn = fork, deadlineMs = 35000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(entry, [], { cwd: environment.FIRECRAWL_CORE_ROOT, env: environment,
      execArgv: ["--max-old-space-size=256"], stdio: ["ignore", "ignore", "ignore", "ipc"] });
    let result; let invalid = false; let timedOut = false; let killTimer;
    const stop = () => {
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => { child.kill("SIGKILL"); }, 1000);
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, deadlineMs);
    child.on("message", message => {
      if (result !== undefined || Buffer.byteLength(JSON.stringify(message) ?? "") > 500000) { invalid = true; stop(); return; }
      result = message;
    });
    child.once("error", () => { invalid = true; stop(); });
    child.once("close", code => {
      clearTimeout(timer); clearTimeout(killTimer);
      if (timedOut) { reject(Error("timeout")); return; }
      if (invalid || code !== 0 || !result?.success) { reject(Error("engine unavailable")); return; }
      resolve(result);
    });
    child.send(input, error => { if (error) { invalid = true; stop(); } });
  });
}

export function createCoreGateway({ token, environment, run = runCoreJob }) {
  if (!/^[\x21-\x7e]{24,256}$/.test(token ?? "")) throw Error("Private scraper credential required");
  const credential = Buffer.from(`Bearer ${token}`);
  let busy = false;
  let stopping = false;
  const sockets = new Set();
  const server = createServer({ maxHeaderSize: 8192, headersTimeout: 10000, requestTimeout: 10000 }, async (request, response) => {
    const send = (status, body) => {
      if (response.destroyed) return;
      response.writeHead(status, { "Content-Type": "application/json", Connection: "close", "Cache-Control": "no-store" }); response.end(JSON.stringify(body));
    };
    const supplied = Buffer.from(request.headers.authorization ?? "");
    if (supplied.length !== credential.length || !timingSafeEqual(supplied, credential)) { send(401, { success: false }); return; }
    if (request.method === "GET" && request.url === "/health") { send(stopping ? 503 : 200, { status: stopping ? "stopping" : "ready", busy }); return; }
    if (request.method !== "POST" || request.url !== "/v2/scrape") { send(404, { success: false }); return; }
    if (busy || stopping) { send(503, { success: false }); return; }
    if (!request.headers["content-type"]?.startsWith("application/json") || Number(request.headers["content-length"]) > 4096) { send(400, { success: false }); return; }
    busy = true;
    try {
      const parts = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > 4096) { send(413, { success: false }); return; } parts.push(chunk); }
      let input; let url;
      try {
        input = JSON.parse(Buffer.concat(parts).toString("utf8")); url = browserTarget(input.url);
        if (JSON.stringify(input.formats) !== '["markdown"]' || input.onlyMainContent !== true || !Number.isInteger(input.timeout)
          || input.timeout < 1000 || input.timeout > 30000 || !Number.isInteger(input.maxAge) || input.maxAge < 0 || input.maxAge > 604800000
          || Object.keys(input).some(key => !["url", "formats", "onlyMainContent", "timeout", "maxAge"].includes(key))) throw Error("invalid");
      } catch { send(400, { success: false }); return; }
      // Marketingbus owns the seven-day evidence cache. Do not create a second
      // cross-business source cache here or enable upstream paid/AI fallbacks.
      const result = await run({ url: url.href, timeout: input.timeout }, { environment });
      const data = result?.data;
      const final = browserTarget(data?.metadata?.url);
      if (final.origin !== url.origin || data.metadata.sourceURL !== url.href || !Number.isInteger(data.metadata.statusCode)
        || data.metadata.statusCode < 200 || data.metadata.statusCode >= 300 || typeof data.markdown !== "string"
        || data.markdown.trim().length < 20 || Buffer.byteLength(data.markdown) > 80000 || /[\u0000\uFFFD]/.test(data.markdown)
        || (data.metadata.title !== undefined && (typeof data.metadata.title !== "string" || data.metadata.title.length > 1000))) throw Error("invalid result");
      send(200, { success: true, data: { markdown: data.markdown, metadata: { url: final.href, sourceURL: url.href,
        statusCode: data.metadata.statusCode, ...(data.metadata.title === undefined ? {} : { title: data.metadata.title }) } } });
    } catch (error) { send(error?.message === "timeout" ? 504 : 502, { success: false }); }
    finally { busy = false; }
  });
  server.maxConnections = 8;
  server.on("connection", socket => { sockets.add(socket); socket.setTimeout(40000, () => socket.destroy()); socket.on("error", () => socket.destroy()); socket.once("close", () => sockets.delete(socket)); });
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("connect", (_request, socket) => socket.destroy()); server.on("upgrade", (_request, socket) => socket.destroy());
  return Object.assign(server, { shutdown: async () => {
    stopping = true;
    // Let the bounded admitted job finish. Server-close stops new connections;
    // the 35-second child deadline bounds draining an outstanding scrape.
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const environment = coreEnvironment({ coreRoot: process.env.FIRECRAWL_CORE_ROOT, browserUrl: process.env.PLAYWRIGHT_MICROSERVICE_URL,
    browserToken: process.env.SCRAPER_BROWSER_TOKEN, redisUrl: process.env.REDIS_URL });
  const server = createCoreGateway({ token: process.env.FIRECRAWL_API_KEY, environment });
  const port = Number(process.env.SCRAPER_GATEWAY_PORT ?? 3002);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error("Invalid gateway port");
  server.listen(port, process.env.SCRAPER_GATEWAY_HOST ?? "127.0.0.1", () => console.log("Private bounded Firecrawl gateway ready"));
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => { void server.shutdown().catch(() => { process.exitCode = 1; }); });
}
