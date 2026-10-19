// Local, disposable runtime acceptance. Never uses production credentials or records.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
const prefix = `marketingbus-browser-check-${randomBytes(4).toString("hex")}`;
if (process.argv.slice(2).some(arg => !["--core", "--application"].includes(arg))) throw Error("Only --core and --application are supported");
const includeApplication = process.argv.includes("--application");
const includeCore = process.argv.includes("--core") || includeApplication;
const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const network = `${prefix}-private`, internet = `${prefix}-internet`;
const proxy = `${prefix}-proxy`, browser = `${prefix}-browser`;
const coreNetwork = `${prefix}-core`, core = `${prefix}-gateway`, redis = `${prefix}-redis`;
const token = randomBytes(24).toString("hex"), password = randomBytes(24).toString("hex");
const coreToken = randomBytes(24).toString("hex");
const database = `${prefix}-postgres`, relay = `${prefix}-test-relay`, databasePassword = randomBytes(24).toString("hex");
const docker = args => execFileSync("docker", args, { encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] }).trim();
const created = [];
const assert = (condition, label) => { if (!condition) throw Error(`FAIL ${label}`); console.log(`PASS ${label}`); };
const exec = (container, code) => JSON.parse(docker(["exec", container, "node", "--input-type=module", "-e", code]));
const call = async (url, body, credential = token) => exec(proxy, `const r=await fetch(${JSON.stringify(url)},{method:${JSON.stringify(body ? "POST" : "GET")},headers:{Authorization:${JSON.stringify(`Bearer ${credential}`)},"Content-Type":"application/json"},${body ? `body:${JSON.stringify(JSON.stringify(body))},` : ""}signal:AbortSignal.timeout(40000)}); console.log(JSON.stringify({status:r.status,body:await r.json()}));`);
try {
  docker(["network", "create", "--internal", network]); created.push(["network", network]);
  docker(["network", "create", internet]); created.push(["network", internet]);
  docker(["create", "--name", proxy, "--network", network, "--network-alias", "proxy", "--init", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--memory=128m", "--cpus=0.5", "-e", `SCRAPER_PROXY_PASSWORD=${password}`, "marketingbus-scraper-proxy:locked-v1"]); created.push(["container", proxy]);
  docker(["network", "connect", internet, proxy]); docker(["start", proxy]);
  docker(["create", "--name", browser, "--network", network, "--network-alias", "browser", "--init", "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=128m", "--shm-size=128m", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--security-opt", `seccomp=${fileURLToPath(new URL("./seccomp_profile.json", import.meta.url))}`, "--memory=512m", "--cpus=1", "-e", `SCRAPER_BROWSER_TOKEN=${token}`, "-e", `SCRAPER_PROXY_PASSWORD=${password}`, "-e", "SCRAPER_PROXY_URL=http://proxy:8899", "marketingbus-scraper-browser:locked-v1"]); created.push(["container", browser]); docker(["start", browser]);
  let health;
  for (let i = 0; i < 20; i++) {
    try { health = await call("http://browser:3003/health"); if (health.status === 200) break; } catch { /* bounded startup polling */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert(health?.status === 200 && health.body.busy === false, "authenticated idle readiness");
  const identity = exec(browser, 'console.log(JSON.stringify({uid:process.getuid(),node:process.versions.node}));');
  assert(identity.uid !== 0 && identity.node.startsWith("22."), "non-root Node 22 runtime");
  const publicPage = await call("http://browser:3003/scrape", { url: "https://firecrawl-test-site.vercel.app/", timeout: 30000 });
  assert(publicPage.status === 200 && publicPage.body.pageStatusCode === 200 && publicPage.body.url === "https://firecrawl-test-site.vercel.app/" && publicPage.body.content.includes("Firecrawl"), "sandboxed Chromium public-page extraction with final URL");
  for (const url of ["https://127.0.0.1/", "https://169.254.169.254/", "https://proxy/"]) {
    assert((await call("http://browser:3003/scrape", { url })).status === 400, `reject restricted target ${url}`);
  }
  assert((await call("http://browser:3003/scrape", { url: "https://expired.badssl.com/", timeout: 10000 })).status === 502, "reject certificate-expired page");
  const direct = exec(browser, 'import net from "node:net";const s=net.connect({host:"1.1.1.1",port:443});s.setTimeout(3000);s.on("connect",()=>{console.log(JSON.stringify({connected:true}));s.destroy();});s.on("error",e=>console.log(JSON.stringify({connected:false,code:e.code})));s.on("timeout",()=>{console.log(JSON.stringify({connected:false,code:"TIMEOUT"}));s.destroy();});');
  assert(direct.connected === false && direct.code === "ENETUNREACH", "network denies direct internet bypass");
  assert((await call("http://browser:3003/health")).body.busy === false, "service reusable after failures");
  if (includeCore) {
    docker(["network", "create", "--internal", coreNetwork]); created.push(["network", coreNetwork]);
    docker(["create", "--name", redis, "--network", coreNetwork, "--network-alias", "redis", "--read-only", "--tmpfs", "/data:rw,nosuid,nodev,size=64m", "--memory=96m", "--cpus=0.25", "redis:7.4-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499", "redis-server", "--save", "", "--appendonly", "no", "--maxmemory", "64mb", "--maxmemory-policy", "noeviction"]); created.push(["container", redis]); docker(["start", redis]);
    docker(["create", "--name", core, "--network", network, "--network-alias", "gateway", "--init", "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--memory=512m", "--cpus=1", "-e", `FIRECRAWL_API_KEY=${coreToken}`, "-e", `SCRAPER_BROWSER_TOKEN=${token}`, "-e", "PLAYWRIGHT_MICROSERVICE_URL=http://browser:3003/scrape", "-e", "REDIS_URL=redis://redis:6379", "marketingbus-scraper-core:locked-v1"]); created.push(["container", core]);
    docker(["network", "connect", "--alias", "gateway", coreNetwork, core]); docker(["start", core]);
    let ready;
    for (let i = 0; i < 20; i++) {
      try { ready = await call("http://gateway:3002/health", undefined, coreToken); if (ready.status === 200) break; } catch { /* bounded startup polling */ }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert(ready?.status === 200, "core gateway starts from built image");
    const request = { url: "https://firecrawl-test-site.vercel.app/", formats: ["markdown"], onlyMainContent: true, timeout: 30000, maxAge: 0 };
    assert((await call("http://gateway:3002/v2/scrape", request, "wrong-test-credential")).status === 401, "core rejects unauthenticated extraction");
    const result = await call("http://gateway:3002/v2/scrape", request, coreToken);
    assert(result.status === 200 && result.body.success === true && result.body.data?.metadata?.url === request.url && result.body.data?.metadata?.statusCode === 200 && result.body.data?.markdown?.includes("Firecrawl"), "built Firecrawl core returns real Markdown and final URL");
    assert((await call("http://gateway:3002/v2/scrape", { ...request, url: "https://169.254.169.254/" }, coreToken)).status === 400, "core rejects metadata destination");
    assert((await call("http://gateway:3002/health", undefined, coreToken)).body.busy === false, "core drains child and remains reusable");
    if (includeApplication) {
      // A new, disposable database: never connect the acceptance runner to an existing DB.
      docker(["create", "--name", database, "--network", coreNetwork, "--network-alias", "database", "--read-only", "--tmpfs", "/var/lib/postgresql/data:rw,nosuid,nodev,size=256m", "--tmpfs", "/var/run/postgresql:rw,nosuid,nodev,size=8m", "--memory=256m", "--cpus=0.5", "-e", `POSTGRES_PASSWORD=${databasePassword}`, "-e", "POSTGRES_DB=scraper_acceptance", "postgres:17-alpine"]); created.push(["container", database]); docker(["start", database]);
      let databaseReady = false;
      for (let i = 0; i < 40; i++) {
        try { docker(["exec", database, "pg_isready", "-U", "postgres", "-d", "scraper_acceptance"]); databaseReady = true; break; } catch { /* bounded startup */ }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      assert(databaseReady, "isolated temporary application database starts");
      // Docker internal networks do not expose host ports. A test-only relay gives
      // the local app exactly two fixed upstreams; core/browser gain no egress.
      const relayCode = 'import net from "node:net";for(const [port,host] of [[3002,"gateway"],[5432,"database"]])net.createServer(client=>{const upstream=net.connect({host,port});client.setTimeout(60000,()=>client.destroy());upstream.setTimeout(60000,()=>upstream.destroy());client.on("error",()=>upstream.destroy());upstream.on("error",()=>client.destroy());client.on("close",()=>upstream.destroy());upstream.on("close",()=>client.destroy());client.pipe(upstream).pipe(client);}).listen(port,"0.0.0.0");';
      docker(["create", "--name", relay, "--network", internet, "--init", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--memory=64m", "--cpus=0.25", "-p", "127.0.0.1::3002", "-p", "127.0.0.1::5432", "marketingbus-scraper-proxy:locked-v1", "node", "--input-type=module", "-e", relayCode]); created.push(["container", relay]);
      docker(["network", "connect", coreNetwork, relay]); docker(["start", relay]);
      const port = (container, number) => {
        const value = docker(["port", container, `${number}/tcp`]);
        if (!/^127\.0\.0\.1:\d+$/.test(value)) throw Error("Acceptance ports must bind only to loopback");
        return value;
      };
      const env = { PATH: process.env.PATH, NODE_ENV: "test", PAID_EXECUTION_ENABLED: "false",
        DATABASE_URL: `postgresql://postgres:${databasePassword}@${port(relay, 5432)}/scraper_acceptance`,
        FIRECRAWL_SELF_HOSTED_URL: `http://${port(relay, 3002)}`, FIRECRAWL_API_KEY: coreToken,
        WEBSITE_EXTRACTION_ENABLED: "true", FIRECRAWL_EGRESS_RESTRICTED: "true", SCRAPER_ACCEPTANCE_DATABASE: "disposable" };
      const applicationCommand = (label, args, timeout) => {
        try { return execFileSync(process.execPath, args, { cwd: projectRoot, env, timeout, stdio: ["ignore", "pipe", "pipe"] }).toString().trim(); }
        catch (error) {
          const output = `${error.stdout ?? ""}\n${error.stderr ?? ""}`.replaceAll(databasePassword, "[redacted]").replaceAll(coreToken, "[redacted]").replace(/postgres(?:ql)?:\/\/\S+/g, "[redacted database URL]");
          throw Error(`${label} failed:\n${output.slice(-3000)}`);
        }
      };
      applicationCommand("Temporary database migration", ["node_modules/prisma/build/index.js", "migrate", "deploy"], 60000);
      console.log(applicationCommand("Application queue acceptance", ["--import", "tsx", "scripts/firecrawl/verify-application.ts"], 180000));
    }
  }
  console.log(`Local ${includeApplication ? "application queue/evidence and runtime" : "runtime"} acceptance passed; deployed onboarding/browser UI acceptance remains separate.`);
} catch (error) {
  // Do not print docker argv: credentials are passed to these disposable services.
  console.error(error?.status !== undefined ? "Runtime command failed; inspect the local Docker environment." : error.message);
  process.exitCode = 1;
} finally {
  let failed = false;
  for (const [kind, name] of created.reverse()) {
    try { docker(kind === "container" ? ["rm", "-f", name] : ["network", "rm", name]); }
    catch { console.error(`Cleanup required: ${name}`); failed = true; }
  }
  if (failed) process.exitCode = 1;
}
