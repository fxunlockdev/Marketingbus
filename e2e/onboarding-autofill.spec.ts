import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createHash } from "node:crypto";
import { db } from "../src/lib/db";
import { heartbeat } from "../src/lib/production/readiness";
import { prepareSetupAutofill } from "../src/lib/onboarding/autofill";
import { runOneBrandAnalysis } from "../src/lib/knowledge/analysis-worker";

test("website setup fills the review fields, preserves a late edit and finishes without duplicate analysis", async ({ page }) => {
  test.setTimeout(120000);
  test.skip(!process.env.TEST_DATABASE_URL, "Explicit local fixture database required");
  if (process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL || !["127.0.0.1", "localhost"].includes(new URL(process.env.TEST_DATABASE_URL!).hostname)) throw Error("Local fixture DB required");
  const email = `autofill-${crypto.randomUUID()}@example.test`, headers = { Origin: "http://127.0.0.1:3000" };
  expect((await page.request.post("/api/auth/register", { headers, data: { name: "Autofill fixture", email, password: "Fixture-only-password-2026!" } })).ok()).toBe(true);
  const user = await db.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } }), organizationId = user.memberships[0].organizationId;
  const workerId = `autofill-browser-${user.id}`;
  const keys = ["OPENAI_API_KEY", "PAID_EXECUTION_ENABLED", "DAILY_SUPPLIER_BUDGET_MICROS", "TOTAL_SUPPLIER_BUDGET_MICROS", "REASONING_RATE_CARD_JSON"];
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    await page.goto("/studio");
    const setup = page.getByRole("region", { name: "Guided business setup" });
    await setup.getByLabel("Your website", { exact: true }).fill("www.example.com");
    await setup.getByLabel("This is my business, and I have permission to read its website.").check();
    await setup.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(setup.getByRole("button", { name: "Read my website again" })).toBeVisible();
    const business = await db.business.findFirstOrThrow({ where: { organizationId } });
    expect(business.website).toBe("https://www.example.com/");
    const scope = { businessId: business.id, organizationId, actorId: user.id };
    // Synthetic imported evidence; no public website or production data is used.
    const name = "Fieldwork Studio", offering = "Home design with a focus on everyday life.", audience = "People planning changes to their homes.";
    const description = "We design thoughtful homes around the people who live in them.";
    const body = `${name}\n${description}`;
    const source = await db.knowledgeSource.create({ data: { businessId: business.id, organizationId, createdBy: user.id, kind: "WEBSITE", title: name, sourceUrl: business.website, body, sha256: createHash("sha256").update(body).digest("hex"), status: "PROPOSED", retrievedAt: new Date() } });
    await setup.getByLabel("Not now", { exact: true }).check();
    await expect(setup.getByText("Review my brand uses up to 20 credits. You’ll check the details before saving.")).toBeVisible();
    await setup.getByRole("button", { name: "Review my brand", exact: true }).click();
    await expect(setup.getByRole("heading", { name: "Does this sound like you?" })).toBeVisible();
    expect((await db.business.findUniqueOrThrow({ where: { id: business.id } })).setupDetails).toHaveProperty("autofill");
    // Only this process can invoke the injected provider. Web remains paid-disabled.
    process.env.OPENAI_API_KEY = "fixture-never-network"; process.env.PAID_EXECUTION_ENABLED = "true";
    process.env.DAILY_SUPPLIER_BUDGET_MICROS = "50000000"; process.env.TOTAL_SUPPLIER_BUDGET_MICROS = "1000000000";
    process.env.REASONING_RATE_CARD_JSON = JSON.stringify([{ provider: "openai", model: "FIXTURE", lane: "creative", inputUsdPerMillion: 2, outputUsdPerMillion: 8, verifiedUntil: "2099-01-01T00:00:00Z" }]);
    await heartbeat(workerId); await db.wallet.update({ where: { organizationId }, data: { available: 100 } });
    await prepareSetupAutofill(scope);
    await page.reload();
    await expect(setup.getByText("Preparing your details…", { exact: true })).toBeVisible();
    const editedOffering = "My own corrected service description.";
    await setup.getByRole("textbox", { name: "What do you do?", exact: true }).fill(editedOffering);
    await runOneBrandAnalysis(async () => ({
      id: "fixture-autofill-result", usage: { input_tokens: 100, output_tokens: 100 },
      text: JSON.stringify({ suggestions: Object.entries({ name, offering, audience }).map(([field, value]) => ({
        field, value, kind: field === "name" ? "EXACT_EXCERPT" : field === "offering" ? "SUMMARY_DRAFT" : "INFERRED_AUDIENCE", reason: "Drafted from the website description for owner review.", citations: [{ sourceId: source.id, sha256: source.sha256, excerpt: field === "name" ? name : description }],
      })) }),
    }));
    await expect(setup.getByLabel("Business name", { exact: true })).toHaveValue(name, { timeout: 15000 });
    await expect(setup.getByLabel("Who is it for?", { exact: true })).toHaveValue(audience);
    await expect(setup.getByText(/The suggested audience is our interpretation/)).toBeVisible();
    await expect(setup.getByRole("textbox", { name: "What do you do?", exact: true })).toHaveValue(editedOffering);
    expect(await db.business.findUniqueOrThrow({ where: { id: business.id } })).toMatchObject({ offering: "", audience: "", confirmedAt: null });
    expect((await new AxeBuilder({ page }).include(".simple-setup").analyze()).violations).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await setup.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await setup.getByLabel("These details are correct.").check();
    await setup.getByRole("button", { name: "Finish setup", exact: true }).click();
    await expect(setup).not.toBeVisible();
    const result = await db.business.findUniqueOrThrow({ where: { id: business.id } });
    expect(result).toMatchObject({ name, offering: editedOffering, audience, setupStep: 6 });
    expect(result.confirmedAt).not.toBeNull();
    expect(await db.brandAnalysis.count({ where: { businessId: business.id } })).toBe(1);
    expect(await db.reservation.count({ where: { organizationId } })).toBe(1);
  } finally {
    const rows = await db.brandAnalysis.findMany({ where: { organizationId }, select: { id: true } });
    await db.supplierAuthorization.deleteMany({ where: { key: { in: rows.map(r => r.id) } } });
    await db.workerHeartbeat.deleteMany({ where: { id: workerId } });
    await db.organization.delete({ where: { id: organizationId } }); await db.user.delete({ where: { id: user.id } });
    for (const key of keys) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; }
    await db.$disconnect();
  }
});
