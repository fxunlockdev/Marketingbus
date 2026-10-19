import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
describe("local storage fixture entry guards", () => {
  const local = "postgresql://fixture:fixture@127.0.0.1:5432/fixture";
  it.each([
    ["missing test database", {}],
    ["mismatched database", { DATABASE_URL: local, TEST_DATABASE_URL: `${local}2` }],
    ["remote database", { DATABASE_URL: "postgresql://fixture:fixture@production.example.test/db", TEST_DATABASE_URL: "postgresql://fixture:fixture@production.example.test/db" }],
    ["wrong protocol", { DATABASE_URL: "https://localhost/db", TEST_DATABASE_URL: "https://localhost/db" }],
    ["disabled TLS", { DATABASE_URL: local, TEST_DATABASE_URL: local, NODE_TLS_REJECT_UNAUTHORIZED: "0" }],
  ])("refuses %s before creating files or starting Docker", async (_name, env) => {
    await expect(exec(process.execPath, ["scripts/private-storage-fixture.mjs"], {
      env: { ...env, NODE_ENV: "test", OPENAI_API_KEY: "never-print-or-use-fixture-secret" }, timeout: 5000,
    })).rejects.toMatchObject({ code: 1, stdout: "", stderr: "Private-storage acceptance failed. No cloud storage or provider was used.\n" });
  });
});
