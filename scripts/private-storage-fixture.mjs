// Local/CI only. No production storage configuration is consumed or changed.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
// SeaweedFS 4.48, official multi-architecture image; never a mutable latest tag.
const image = "chrislusf/seaweedfs@sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d";
const name = `marketingbus-storage-test-${randomUUID()}`;
let phase = "local configuration validation";
const controller = new AbortController();
const interrupt = () => controller.abort();
process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
const baseEnv = Object.fromEntries(["PATH", "HOME", "TMPDIR", "SystemRoot", "LANG", "LC_ALL", "TEST_FFMPEG_PATH", "TEST_FFPROBE_PATH"]
  .flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
const command = (program, args, options = {}) => {
  phase = `${program} ${args[0]}`;
  return exec(program, args, { cwd: root, env: baseEnv, timeout: 120_000, maxBuffer: 1024 * 1024, ...options });
};

async function child(args, env) {
  controller.signal.throwIfAborted();
  await new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, args, { cwd: root, env, stdio: "inherit", signal: controller.signal });
    const timer = setTimeout(() => proc.kill("SIGTERM"), 12 * 60_000);
    let launchError;
    proc.once("error", error => { launchError = error; });
    proc.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && !signal && !controller.signal.aborted && !launchError) resolve();
      else reject(Error("Storage acceptance subprocess did not pass."));
    });
  });
}

async function main() {
  const database = process.env.TEST_DATABASE_URL;
  assert.ok(database && process.env.DATABASE_URL === database, "Use a matching explicit local test database.");
  const target = new URL(database);
  assert.ok(target.protocol === "postgresql:" && ["127.0.0.1", "localhost"].includes(target.hostname), "Remote database fixtures are prohibited.");
  assert.ok(!process.env.NODE_TLS_REJECT_UNAUTHORIZED || process.env.NODE_TLS_REJECT_UNAUTHORIZED === "1", "TLS verification cannot be disabled.");
  // Next loads these independently of the child environment. Do not silently consume operator secrets.
  for (const file of [".env", ".env.local", ".env.production", ".env.production.local"]) {
    try { await access(join(root, file)); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    throw Error("Use a clean test checkout without local environment files.");
  }
  const scratch = await mkdtemp(join(tmpdir(), "marketingbus-storage-test-"));
  let proxy, containerCreated = false;
  try {
    const keyPath = join(scratch, "private.key"), certPath = join(scratch, "public.crt");
    await command("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=Marketingbus local storage test", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", keyPath, "-out", certPath]);
    const accessKey = randomBytes(16).toString("hex"), secretKey = randomBytes(32).toString("hex"), bucket = `fixture-${randomUUID()}`;
    const storageEnv = { ...baseEnv, AWS_ACCESS_KEY_ID: accessKey, AWS_SECRET_ACCESS_KEY: secretKey, S3_BUCKET: bucket };
    console.info("Starting isolated loopback-only storage; production credentials are not inherited.");
    await command("docker", ["pull", image]);
    controller.signal.throwIfAborted();
    // No host data volume, published admin/RPC port, elevated privilege or persistent data.
    await command("docker", ["create", "--name", name, "--label", `marketingbus.storage-fixture=${name}`,
      "--user", "65534:65534", "--read-only", "--tmpfs", "/tmp:rw,nosuid,noexec,size=268435456,mode=1777",
      "--tmpfs", "/data:rw,nosuid,noexec,size=134217728,mode=1777", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--memory", "512m", "--cpus", "1", "--pids-limit", "128", "-p", "127.0.0.1::8333",
      "-e", "AWS_ACCESS_KEY_ID", "-e", "AWS_SECRET_ACCESS_KEY", "-e", "S3_BUCKET", "--entrypoint", "weed", image,
      "mini", "-dir=/tmp/data", "-ip=127.0.0.1", "-ip.bind=0.0.0.0", "-master.telemetry=false", "-master.volumeSizeLimitMB=16",
      "-volume.max=4", "-admin.ui=false", "-webdav=false", "-s3.port.iceberg=0", "-s3.port.lance=0", "-s3.iam=false", "-s3.autoCreateBucket=false"], { env: storageEnv });
    containerCreated = true;
    await command("docker", ["start", name]);
    const binding = (await command("docker", ["port", name, "8333/tcp"])).stdout.trim();
    phase = "loopback storage port binding";
    assert.match(binding, /^127\.0\.0\.1:\d+$/);
    const upstreamPort = Number(binding.split(":")[1]);
    // The actual application S3 client still verifies HTTPS and signs every request.
    // Only the fixture's in-memory TLS terminator forwards to its local S3 process.
    proxy = createServer({ key: await readFile(keyPath), cert: await readFile(certPath) }, (incoming, outgoing) => {
      const upstream = request({ hostname: "127.0.0.1", port: upstreamPort, method: incoming.method, path: incoming.url, headers: incoming.headers }, response => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers); response.pipe(outgoing);
        response.on("error", () => outgoing.destroy());
      });
      upstream.setTimeout(30_000, () => upstream.destroy());
      upstream.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
      incoming.on("aborted", () => upstream.destroy());
      outgoing.on("close", () => upstream.destroy());
      incoming.pipe(upstream);
    });
    proxy.requestTimeout = 35_000;
    await new Promise((resolve, reject) => { proxy.once("error", reject); proxy.listen(0, "127.0.0.1", resolve); });
    const address = proxy.address(); assert.ok(address && typeof address !== "string");
    const env = { ...baseEnv, CI: "true", DATABASE_URL: database, TEST_DATABASE_URL: database, APP_ORIGIN: "http://127.0.0.1:3000",
      PAID_EXECUTION_ENABLED: "false", EMAIL_DELIVERY_ENABLED: "false", WEBSITE_EXTRACTION_ENABLED: "false", SOCIAL_EXECUTION_ENABLED: "false", MOTION_RENDERING_ENABLED: "false",
      RUN_ASSET_STORAGE_E2E: "true", PRIVATE_STORAGE_FIXTURE: name, NODE_EXTRA_CA_CERTS: certPath,
      ASSET_S3_ENDPOINT: `https://127.0.0.1:${address.port}`, ASSET_S3_REGION: "us-east-1", ASSET_S3_BUCKET: bucket, ASSET_S3_ACCESS_KEY_ID: accessKey, ASSET_S3_SECRET_ACCESS_KEY: secretKey };
    phase = "S3 transport acceptance";
    await child(["--import", "tsx", "scripts/verify-private-storage.ts"], env);
    phase = "browser acceptance";
    await child(["node_modules/@playwright/test/cli.js", "test", ...process.argv.slice(2)], env);
  } catch (error) {
    console.error(`Storage test stopped during ${phase}.`);
    throw error;
  } finally {
    if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); }
    if (containerCreated) {
      const label = (await command("docker", ["inspect", "--format", '{{index .Config.Labels "marketingbus.storage-fixture"}}', name])).stdout.trim();
      assert.equal(label, name, "Refusing to remove an unrelated container.");
      await command("docker", ["rm", "--force", name]);
    }
    await rm(scratch, { recursive: true });
    console.info("Removed this run's synthetic storage container, objects and temporary TLS files.");
  }
}
main().catch(() => { console.error("Private-storage acceptance failed. No cloud storage or provider was used."); process.exitCode = 1; })
  .finally(() => { process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt); });
