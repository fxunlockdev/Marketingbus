// Disposable, real-engine acceptance. No application/provider credentials or user data.
// Pull the pinned base first; build the exact dedicated gateway, never the upstream API.
// This script never installs or creates hosted services.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readWebsite } from "../../src/lib/knowledge/scraper-client";

const image = "unclecode/crawl4ai@sha256:636a6f9e5127f54771f14f709bf1b95693aacc30512426b26d09768b0269f1f4";
const name = `marketingbus-crawl4ai-check-${randomBytes(4).toString("hex")}`;
const gatewayImage = `${name}:local`;
const token = randomBytes(32).toString("hex");
const docker = (args: string[]) => execFileSync("docker", args, {
  encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"],
}).trim();
const check = (label: string) => console.log(`PASS ${label}`);
let created = false, built = false;

async function main() {
  assert.equal(process.argv.length, 2, "This local check accepts no targets or credentials");
  docker(["image", "inspect", image]);
  docker(["build", "--platform", "linux/amd64", "--pull=false", "-t", gatewayImage,
    fileURLToPath(new URL(".", import.meta.url))]);
  built = true;
  docker(["create", "--name", name, "--platform", "linux/amd64",
    "--cap-drop=ALL", "--security-opt=no-new-privileges",
    "--memory=1g", "--cpus=1", "--pids-limit=256",
    "--ulimit", "core=0", "-p", "127.0.0.1::11235",
    "-e", `CRAWL4AI_API_TOKEN=${token}`, gatewayImage]);
  created = true;
  docker(["start", name]);
  const address = docker(["port", name, "11235/tcp"]);
  assert.match(address, /^127\.0\.0\.1:\d+$/);
  const base = new URL(`http://${address}/`);
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(new URL("health", base), { headers, signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        const state = await response.json();
        assert.equal(state.mode, "html-only", "Acceptance must target the deployed HTML reader");
        ready = state.status === "ready";
        if (ready) break;
      } else await response.body?.cancel();
    } catch { /* bounded startup polling */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!ready) {
    // Startup only: no website or application input has been sent to this container.
    const logs = spawnSync("docker", ["logs", "--tail", "60", name], { encoding: "utf8", timeout: 10000 });
    console.error(`${logs.stdout ?? ""}\n${logs.stderr ?? ""}`.replaceAll(token, "[redacted]").slice(-6000));
    throw Error("Crawl4AI did not become ready within the local startup deadline");
  }
  check("dedicated HTML gateway starts with loopback-only host access at the hosted resource limit");
  const denied = await fetch(new URL("crawl", base), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ urls: ["https://example.com/"] }), signal: AbortSignal.timeout(5000),
  });
  await denied.body?.cancel();
  assert.ok([401, 403].includes(denied.status), "Unauthenticated crawl must be rejected");
  check("anonymous requests cannot start extraction");
  const hooks = await fetch(new URL("execute_js", base), {
    method: "POST", headers, body: JSON.stringify({ url: "https://example.com/", script: "1" }),
    signal: AbortSignal.timeout(5000),
  });
  await hooks.body?.cancel();
  assert.equal(hooks.status, 404);
  check("general-purpose JavaScript API is absent");

  const page = await readWebsite(base, "https://example.com/", headers, fetch, "crawl4ai");
  assert.ok(page.markdown.includes("Example Domain"));
  assert.equal(page.metadata.url, "https://example.com/");
  assert.equal(page.metadata.statusCode, 200);
  check("actual Crawl4AI result passes the production Markdown/final-URL transport");
  for (const target of ["https://127.0.0.1/", "https://169.254.169.254/"]) {
    // Exercise the engine's policy too, not only Marketingbus's URL preflight.
    const response = await fetch(new URL("crawl", base), {
      method: "POST", headers, body: JSON.stringify({ urls: [target] }), signal: AbortSignal.timeout(10000),
    });
    const body = await response.json();
    assert.ok(response.status >= 400 || body.results?.every((row: { success: boolean }) => row.success === false),
      "Engine must reject private destinations");
  }
  check("engine refuses loopback and cloud-metadata destinations");
  await assert.rejects(readWebsite(base, "https://expired.badssl.com/", headers, fetch, "crawl4ai"));
  check("invalid public TLS certificate cannot become accepted evidence");
  const again = await readWebsite(base, "https://example.com/", headers, fetch, "crawl4ai");
  assert.ok(again.markdown.includes("Example Domain"));
  check("engine remains usable after rejected requests");
  // Only resource statistics, never container environment, raw pages or logs.
  console.log(`Local sample (amd64; may be emulated): ${docker(["stats", "--no-stream", "--format", "{{.MemUsage}} / CPU {{.CPUPerc}}", name])}`);
  console.log("Local transport acceptance only; hosted isolation, throughput and billing remain unverified.");
}
main().catch(error => {
  // Docker failures include secret-bearing argv; never print those objects/messages.
  console.error(error && typeof error === "object" && "status" in error
    ? "Local Docker runtime failed; no hosted settings were changed."
    : error instanceof Error ? `${error.name}: ${error.message}` : "Runtime acceptance failed.");
  process.exitCode = 1;
}).finally(() => {
  if (created) {
    try { docker(["rm", "-f", name]); }
    catch { console.error(`Local test container requires cleanup: ${name}`); process.exitCode = 1; }
  }
  if (built) {
    try { docker(["image", "rm", gatewayImage]); }
    catch { console.error(`Local test image requires cleanup: ${gatewayImage}`); process.exitCode = 1; }
  }
});
