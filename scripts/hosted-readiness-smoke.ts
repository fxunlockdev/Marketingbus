// Manual, non-billable hosted check. Does not accept a production quote or fund a wallet.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chromium } from "@playwright/test";
async function main() {
  assert.equal(process.env.CONFIRM_HOSTED_SMOKE, "palm-clay-readiness-20261014");
  assert.ok(process.env.PILOT_INVITE_CODE);
  const origin = "https://marketingbus-web-production.up.railway.app";
  const browser = await chromium.launch({ channel: "chrome" });
  const context = await browser.newContext({ baseURL: origin, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  const headers = { Origin: origin };
  try {
    const registered = await context.request.post("/api/auth/register", { headers, data: {
      name: "Palm Clay Hosted Test", email: `palm-clay-readiness-${Date.now()}@example.invalid`,
      password: randomBytes(24).toString("base64url"), invitationCode: process.env.PILOT_INVITE_CODE,
    } });
    assert.equal(registered.status(), 200);
    const created = await context.request.post("/api/businesses", { headers, data: {
      name: "Palm & Clay — Fictional Test", offering: "Fictional beginner pottery workshops for adults in Dubai. This is a test business, not a real venue.",
      audience: "Solo beginners who want a hands-on break from screens", goal: "Ask about beginner sessions",
      difference: "Make a useful object without needing artistic experience or a friend group",
      restrictions: "No invented dates, prices, venues, statistics or testimonials", channels: ["Instagram"],
    } });
    assert.equal(created.status(), 200);
    const { id } = await created.json();
    for (const action of ["confirm", "plan"]) {
      const r = await context.request.post(`/api/businesses/${id}`, { headers, data: { action, version: 1 } });
      assert.equal(r.status(), 200);
    }
    await page.goto("/studio");
    await page.getByRole("button", { name: "Content plan", exact: true }).click();
    await page.getByLabel("What should this planned creative communicate?", { exact: true }).fill("An understated introduction to making a bowl with clay instead of spending another weekend scrolling. Welcome solo beginners.");
    const responsePromise = page.waitForResponse(r => r.url().endsWith("/production") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Get a credit quote · no generation yet" }).click();
    const response = await responsePromise;
    const result = await response.json();
    console.info(JSON.stringify({ hostedSignup: registered.status(), businessId: id, confirmed: true, planned: true,
      quoteStatus: response.status(), quote: result.quote ? { credits: result.quote.credits, model: result.quote.model } : undefined,
      error: result.error, paidAcceptanceAttempted: false }));
    assert.equal(response.status(), 200, "Matching execution-enabled production worker must be ready");
    await page.getByRole("button", { name: /Authorize up to \d+ credits/ }).waitFor();
    await page.screenshot({ path: "../outputs/palm-clay-hosted-readiness.png", fullPage: true });
  } finally {
    const loggedOut = await context.request.post("/api/auth/logout", { headers, data: {} });
    assert.equal(loggedOut.status(), 200);
    await browser.close();
  }
}
void main().catch(() => { console.error("Hosted readiness test stopped; no paid acceptance attempted."); process.exitCode = 1; });
