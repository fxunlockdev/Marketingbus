// Explicit, non-billable hosted acceptance. Creates one unfunded synthetic account, no provider job.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";
import sharp from "sharp";
const marker = "hosted-evidence-20261014", path = "../outputs/hosted-evidence-20261014.json";
const report: Record<string, unknown> = { marker, paidCalls: 0, checks: [] };
async function main() {
  assert.equal(process.env.CONFIRM_HOSTED_EVIDENCE, marker); assert.ok(process.env.PILOT_INVITE_CODE);
  assert.ok(!existsSync(path), "Do not rerun automatically and create duplicate hosted fixtures.");
  // Durable marker before creating remote data. A failure requires investigation, not blind replay.
  await writeFile(path, JSON.stringify({ ...report, status: "started" }), { mode: 0o600 });
  const origin = "https://marketingbus-web-production.up.railway.app", headers = { Origin: origin };
  const browser = await chromium.launch({ channel: "chrome" });
  const context = await browser.newContext({ baseURL: origin, viewport: { width: 1360, height: 1000 } });
  const page = await context.newPage(); page.setDefaultTimeout(30000);
  let businessId: string | undefined, sourceId: string | undefined, assetId: string | undefined;
  const checks = report.checks as string[];
  try {
    const registered = await context.request.post("/api/auth/register", { headers, data: { name: "Evidence Release Test", email: `${marker}@example.invalid`, password: randomBytes(24).toString("base64url"), invitationCode: process.env.PILOT_INVITE_CODE } });
    assert.equal(registered.status(), 200);
    assert.ok(registered.headers()["set-cookie"].includes("HttpOnly")); assert.ok(registered.headers()["set-cookie"].includes("Secure"));
    const created = await context.request.post("/api/businesses", { headers, data: { name: "Clay Evidence — Fictional Release Test", offering: "Fictional beginner pottery sessions. Test data only, not a real business.", audience: "Solo beginners", goal: "Ask about sessions", channels: ["Instagram"] } });
    assert.equal(created.status(), 200); businessId = (await created.json()).id; report.businessId = businessId;
    const source = await context.request.post(`/api/businesses/${businessId}/sources`, { headers, data: { action: "document", title: "Fictional source fixture", text: "This is a fictional test business. Solo beginners are welcome to our sessions.", rightsConfirmed: true } });
    assert.equal(source.status(), 200); sourceId = (await source.json()).sourceId;
    const excerpt = await context.request.post(`/api/businesses/${businessId}/sources`, { headers, data: { action: "evidence", sourceId, quote: "Solo beginners are welcome to our sessions." } }); assert.equal(excerpt.status(), 200);
    checks.push("invited signup with Secure/HttpOnly cookie", "source import and exact evidence check");
    const png = await sharp({ create: { width: 120, height: 90, channels: 4, background: "#b65e39" } }).png().toBuffer();
    const uploaded = await context.request.post(`/api/businesses/${businessId}/assets`, { headers: { ...headers, "Content-Type": "application/octet-stream", "x-asset-label": "Synthetic release fixture", "x-asset-purpose": "reference", "x-asset-rights": "confirmed" }, data: png });
    assert.equal(uploaded.status(), 200); assetId = (await uploaded.json()).asset.id;
    const endpoint = `/api/businesses/${businessId}/assets/${assetId}`;
    assert.equal((await context.request.get(endpoint)).status(), 200);
    for (const action of ["approve", "archive", "restore"] as const) {
      assert.equal((await context.request.post(endpoint, { headers, data: action === "approve" ? { action, approved: true } : { action } })).status(), 200);
      if (action === "archive") assert.equal((await context.request.get(endpoint)).status(), 404);
    }
    const assets = await (await context.request.get(`/api/businesses/${businessId}/assets`)).json(); assert.equal(assets.assets[0].approvedForGeneration, false);
    checks.push("hosted private upload/read", "permission, removal/access denial and restoration without auto-approval");
    await page.goto("/studio"); await page.getByRole("button", { name: "Brand", exact: true }).click();
    await page.getByRole("img", { name: "Synthetic release fixture", exact: true }).waitFor();
    await page.getByRole("heading", { name: "Fictional source fixture", exact: true }).waitFor();
    await page.getByRole("region", { name: "Business evidence" }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: "../outputs/hosted-evidence-20261014.png" });
    await page.goto("/account"); await page.getByRole("heading", { name: "Account security" }).waitFor();
    assert.ok(await page.getByRole("button", { name: "Send verification link" }).isDisabled());
    checks.push("hosted brand evidence screen and disabled-unconfigured email UI");
    for (const action of ["confirm", "plan"]) assert.equal((await context.request.post(`/api/businesses/${businessId}`, { headers, data: { action, version: 1 } })).status(), 200);
    await page.goto("/studio"); await page.getByRole("button", { name: "Content plan", exact: true }).click();
    await page.getByLabel("What should this planned creative communicate?", { exact: true }).fill("Welcome solo beginners to fictional pottery sessions. No dates or prices.");
    const promised = page.waitForResponse(r => r.url().endsWith("/production") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Get a credit quote · no generation yet" }).click();
    const quote = await promised; assert.equal(quote.status(), 200); report.quote = (await quote.json()).quote;
    checks.push("confirmed profile, planning and quote accepted matching new worker; no paid acceptance");
    report.status = "passed";
  } finally {
    try {
      if (sourceId && businessId) { const removed = await context.request.post(`/api/businesses/${businessId}/sources`, { headers, data: { action: "delete", sourceId } }); assert.equal(removed.status(), 200); checks.push("synthetic source deleted"); }
      if (assetId && businessId) { const archived = await context.request.post(`/api/businesses/${businessId}/assets/${assetId}`, { headers, data: { action: "archive" } }); assert.equal(archived.status(), 200); checks.push("synthetic image archived; physical deletion scheduled after seven-day restore period"); }
    } finally {
      try { const logout = await context.request.post("/api/auth/logout", { headers, data: {} }); assert.equal(logout.status(), 200); assert.equal((await context.request.get("/api/identity")).status(), 401); checks.push("logout 200 and subsequent session access 401"); } finally { await browser.close(); }
    }
  }
}
void main().catch(() => { report.status = "failed"; report.error = "Inspect the last completed step; no provider generation was authorized."; process.exitCode = 1; }).finally(async () => { await writeFile(path, JSON.stringify(report, null, 2), { mode: 0o600 }); console.info(JSON.stringify(report)); });
