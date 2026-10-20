import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const script = "scripts/crawl4ai/start.sh";
it("passes the isolated HTML gateway security tests without network or Python dependencies", () => {
  const result = spawnSync("python3", ["-B", "scripts/crawl4ai/test_html_runtime.py"], { encoding: "utf8", timeout: 15000 });
  expect(result.status, result.stderr).toBe(0);
}, 20000);
const safe = {
  PATH: process.env.PATH,
  NODE_ENV: "test" as const,
  CRAWL4AI_API_TOKEN: "disposable-test-token",
  CRAWL4AI_CHROMIUM_SANDBOX: "true",
  CRAWL4AI_ALLOW_INTERNAL_URLS: "false",
  CRAWL4AI_ALLOW_INSECURE_TLS: "false",
  CRAWL4AI_HOOKS_ENABLED: "false",
  CRAWL4AI_EXECUTE_JS_ENABLED: "false",
  CRAWL4AI_ALLOW_DEEP_CRAWL: "false",
};
it("has valid shell syntax", () => {
  expect(spawnSync("bash", ["-n", script]).status).toBe(0);
});
it.each(Object.keys(safe).filter(key => key.startsWith("CRAWL4AI_")))("refuses unsafe/missing %s before starting the engine", key => {
  const env = { ...safe, [key]: key === "CRAWL4AI_API_TOKEN" ? "" : safe[key as keyof typeof safe] === "true" ? "false" : "true" };
  const result = spawnSync("bash", [script], { env, encoding: "utf8" });
  expect(result.status).not.toBe(0);
  expect(result.stderr).not.toContain("/app/entrypoint.sh");
  expect(result.stderr).not.toContain("disposable-test-token");
});
it("pins the isolated image and excludes application secrets from the build context", () => {
  const dockerfile = readFileSync("scripts/crawl4ai/Dockerfile", "utf8");
  expect(dockerfile).toContain("FROM unclecode/crawl4ai@sha256:636a6f9e5127f54771f14f709bf1b95693aacc30512426b26d09768b0269f1f4");
  expect(dockerfile).toContain("USER appuser");
  expect(dockerfile).not.toMatch(/COPY\s+\.\s/);
  expect(dockerfile).toContain('CMD ["python", "-I", "/app/html_server.py"]');
  expect(dockerfile).toContain("HEALTHCHECK NONE");
  expect(readFileSync("scripts/crawl4ai/.dockerignore", "utf8").trim().split("\n")).toEqual(["*", "!Dockerfile", "!config.yml", "!start.sh", "!html_worker.py", "!html_server.py"]);
});
it("accepts the same dedicated HTML gateway and resource limit as production", () => {
  const acceptance = readFileSync("scripts/crawl4ai/verify-runtime.ts", "utf8");
  expect(acceptance).toContain('docker(["build", "--platform", "linux/amd64", "--pull=false", "-t", gatewayImage');
  expect(acceptance).toContain('"--memory=1g", "--cpus=1"');
  expect(acceptance).toContain('assert.equal(state.mode, "html-only"');
  expect(acceptance).toContain('docker(["image", "rm", gatewayImage])');
  expect(acceptance).not.toContain("seccomp_profile.json");
});
