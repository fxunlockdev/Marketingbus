import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
const local = process.env.TEST_DATABASE_URL;
test.skip(!local, "Requires explicitly configured local test database.");
if (local && (process.env.DATABASE_URL !== local || !["127.0.0.1", "localhost"].includes(new URL(local).hostname))) throw Error("Refusing non-local fixture writes");
const db = new PrismaClient();
test.afterAll(async () => { await db.$disconnect(); });
test("document import, exact evidence, tenant isolation and explicit deletion", async ({ page, playwright }) => {
  const email = `sources-${crypto.randomUUID()}@example.test`, otherEmail = `sources-other-${crypto.randomUUID()}@example.test`;
  const headers = { Origin: "http://127.0.0.1:3000" };
  const outsider = await playwright.request.newContext({ baseURL: "http://127.0.0.1:3000" });
  const organizations: string[] = [];
  try {
    for (const [client, address] of [[page.request, email], [outsider, otherEmail]] as const) {
      expect((await client.post("/api/auth/register", { headers, data: { name: "Evidence Fixture", email: address, password: "Test-only-password-2026!" } })).ok()).toBe(true);
      const user = await db.user.findUniqueOrThrow({ where: { email: address }, include: { memberships: true } });
      organizations.push(...user.memberships.map(m => m.organizationId));
    }
    const created = await page.request.post("/api/businesses", { headers, data: { name: "Evidence Studio", offering: "Handmade ceramics", audience: "Homeowners", goal: "Book a visit", channels: ["Instagram"] } });
    expect(created.ok()).toBe(true); const { id } = await created.json();
    await page.goto("/studio"); await page.getByRole("button", { name: "Brand", exact: true }).click();
    const region = page.getByRole("region", { name: "Business evidence" });
    await expect(region.locator(".error")).toBeHidden();
    await expect(region.locator(".checkbox-label")).toHaveCSS("flex-direction", "row");
    await expect(region.getByRole("button", { name: "Save document for review" })).toBeDisabled();
    await region.getByLabel("I have permission to import this business content.").check();
    await region.getByLabel("Text document (.txt or .md, up to 24 KB)").setInputFiles({ name: "studio-proof.md", mimeType: "text/markdown", buffer: Buffer.from("Our ceramics are handmade in our own studio. Studio visits are available by appointment.") });
    await expect(region.getByLabel("Document title", { exact: true })).toHaveValue("studio-proof.md");
    await region.getByRole("button", { name: "Save document for review" }).click();
    await expect(region.getByRole("heading", { name: "studio-proof.md" })).toBeVisible();
    expect((await db.business.findUniqueOrThrow({ where: { id } })).proof).toBe("");
    const source = await db.knowledgeSource.findFirstOrThrow({ where: { businessId: id } });
    expect((await outsider.get(`/api/businesses/${id}/sources`)).status()).toBe(404);
    expect((await outsider.post(`/api/businesses/${id}/sources`, { headers, data: { action: "delete", sourceId: source.id } })).status()).toBe(404);
    await region.getByLabel("Exact excerpt to use as evidence").fill("We are the best studio in the world.");
    await region.getByRole("button", { name: "Check excerpt · studio-proof.md" }).click();
    await expect(region.getByRole("alert")).toContainText("exact excerpt");
    await region.getByLabel("Exact excerpt to use as evidence").fill("Our ceramics are handmade in our own studio.");
    await region.getByRole("button", { name: "Check excerpt · studio-proof.md" }).click();
    await expect(region.getByRole("status")).toContainText("Exact excerpt verified");
    await region.scrollIntoViewIfNeeded(); await page.screenshot({ path: "../outputs/marketingbus-evidence-reviewed.png" });
    await region.getByRole("button", { name: "Delete source · studio-proof.md" }).click();
    await region.getByRole("button", { name: "Confirm source deletion" }).click();
    await expect(region.getByRole("heading", { name: "studio-proof.md" })).toHaveCount(0);
    expect(await db.knowledgeSource.count({ where: { businessId: id } })).toBe(0);
    const failed = await db.knowledgeSource.create({ data: { businessId: id, organizationId: source.organizationId, createdBy: source.createdBy, kind: "WEBSITE", title: "Website import fixture", sourceUrl: "https://example.com/about", status: "FAILED" } });
    await db.job.create({ data: { businessId: id, organizationId: source.organizationId, kind: "WEBSITE_READ", key: `source:${failed.id}`, payload: { sourceId: failed.id, url: failed.sourceUrl }, status: "FAILED", errorCode: "SCRAPER_AUTH_REQUIRED", attempts: 1, maxAttempts: 1 } });
    await page.reload(); await page.getByRole("button", { name: "Brand", exact: true }).click();
    await expect(region.getByRole("status")).toContainText("administrator to check the scraper connection");
    await expect(region.getByRole("status")).toContainText("saved business details are unchanged");
    expect((await outsider.get(`/api/businesses/${id}/sources`)).status()).toBe(404);
  } finally {
    await db.organization.deleteMany({ where: { id: { in: organizations } } });
    await db.user.deleteMany({ where: { email: { in: [email, otherEmail] } } });
    await outsider.dispose();
  }
});
