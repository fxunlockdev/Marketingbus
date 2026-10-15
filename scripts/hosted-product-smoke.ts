// Explicit manual smoke: synthetic account/brand, no paid calls, email, upload or publication.
// Fixture records remain visibly labelled in the private pilot; no unsafe production DB cleanup.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chromium } from "@playwright/test";

async function main() {
  assert.equal(process.env.CONFIRM_HOSTED_PRODUCT_SMOKE, "product-readiness-20261015");
  assert.ok(process.env.PILOT_INVITE_CODE);
  const origin = "https://marketingbus-web-production.up.railway.app";
  const browser = await chromium.launch({ channel: "chrome" });
  const context = await browser.newContext({ baseURL: origin });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  const headers = { Origin: origin };
  try {
    const health = await context.request.get("/api/health");
    assert.equal(health.status(), 200);
    assert.equal(health.headers()["cache-control"], "no-store");
    assert.equal((await context.request.get("/api/mfa")).status(), 401);
    const registered = await context.request.post("/api/auth/register", { headers, data: {
      name: "Product Readiness Fixture",
      email: `product-readiness-${Date.now()}@example.invalid`,
      password: randomBytes(24).toString("base64url"),
      invitationCode: process.env.PILOT_INVITE_CODE,
    } });
    assert.equal(registered.status(), 200);
    const created = await context.request.post("/api/businesses", { headers, data: {
      name: "Product Readiness — Fictional Test",
      offering: "Synthetic architecture consultation fixture, not a real business",
      audience: "Test homeowners", goal: "Verify private workspace screens", channels: ["Facebook"],
    } });
    assert.equal(created.status(), 200);
    const { id } = await created.json();
    for (const action of ["confirm", "plan"]) {
      assert.equal((await context.request.post(`/api/businesses/${id}`, { headers, data: { action, version: 1 } })).status(), 200);
    }
    const social = await context.request.get(`/api/businesses/${id}/social`);
    assert.equal(social.status(), 200);
    assert.equal(social.headers()["cache-control"], "no-store");
    const dashboard = await social.json();
    assert.equal(dashboard.connections.length, 0);
    assert.equal(dashboard.publications.length, 0);
    assert.equal(dashboard.summary.length, 0);
    const composition = await context.request.get(`/api/businesses/${id}/compositions`);
    assert.equal(composition.status(), 200);
    const mfa = await context.request.get("/api/mfa");
    assert.equal(mfa.status(), 200);
    const security = await mfa.json();
    assert.equal(security.enabled, false);
    await page.goto("/studio");
    for (const name of ["Design studio", "Publishing & analytics", "Team"]) {
      await page.getByRole("button", { name, exact: true }).click();
      await page.getByRole("heading", { level: 1, name: name === "Team" ? "Workspace team" : name, exact: true }).waitFor();
    }
    await page.getByRole("heading", { level: 3, name: "Product Readiness Fixture", exact: true }).waitFor();
    await page.goto("/account");
    await page.getByRole("heading", { name: "Authenticator security" }).waitFor();
    console.info(JSON.stringify({ health: "ok", signup: "passed", brand: "confirmed", planning: "passed", newScreens: "passed", socialRecords: "empty-no-fake-data", mfaConfigured: security.available, paidCalls: 0, emails: 0, publications: 0, fixtureBusinessId: id }));
  } finally {
    await context.request.post("/api/auth/logout", { headers, data: {} });
    await browser.close();
  }
}
void main().catch(() => { console.error("Hosted product smoke failed. No paid model, email or publication actions are included in this script."); process.exitCode = 1; });
