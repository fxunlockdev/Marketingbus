import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { unavailableOrganic } from "../src/lib/social/account-data-contracts";
const local = process.env.TEST_DATABASE_URL;
test.skip(!local, "Requires explicit localhost fixture database.");
if (local && (process.env.DATABASE_URL !== local || !["localhost", "127.0.0.1"].includes(new URL(local).hostname))) throw Error("Refusing non-local fixture writes");
const db = new PrismaClient();
test.afterAll(async () => db.$disconnect());
test("saved social data is scoped, accessible, safely rendered and explicitly removable", async ({ page, browser }) => {
  const email = `data-browser-${randomUUID()}@example.test`, headers = { Origin: "http://127.0.0.1:3000" };
  let organizationId: string | undefined;
  try {
    expect((await page.request.post("/api/auth/register", { headers, data: { name: "Data browser fixture", email, password: "Test-only-password-2026!" } })).ok()).toBe(true);
    const response = await page.request.post("/api/businesses", { headers, data: { name: "Social data studio", offering: "Architecture consultations", audience: "Homeowners", goal: "Book consultations", channels: ["Facebook"] } });
    const { id } = await response.json(); organizationId = (await db.business.findUniqueOrThrow({ where: { id } })).organizationId;
    const snapshot = { provider: "Facebook", externalAccountId: "789", observedAt: new Date().toISOString(), definitionVersion: "browser-fixture", profile: { name: "Saved page profile", followers: 0, likes: null, mediaCount: null }, lifetimeOrganic: unavailableOrganic(), hasMore: true,
      posts: [{ externalId: "789_123", text: "<script>alert('not executable')</script> Company news", textTruncated: false, publishedAt: "2026-01-01T00:00:00Z", permalink: "https://www.facebook.com/789/posts/123", format: "POST", likes: null, comments: null, sponsored: null }] };
    const account = await db.socialConnection.create({ data: { businessId: id, organizationId, provider: "Facebook", externalAccountId: "789", label: "Browser fixture page", encryptedToken: "synthetic-private-token", permissions: [], expiresAt: new Date(Date.now() + 3600000), dataSnapshot: snapshot, dataFetchedAt: new Date() } });
    const endpoint = `/api/businesses/${id}/connections/data`, readUrl = `${endpoint}?connectionId=${account.id}`;
    const api = await page.request.get(readUrl); expect(api.ok()).toBe(true); expect(api.headers()["cache-control"]).toContain("no-store"); expect(await api.text()).not.toContain("synthetic-private-token");
    expect((await page.request.post(endpoint, { headers, data: { action: "refresh", connectionId: account.id } })).status()).toBe(503);
    expect((await page.request.post(endpoint, { headers: { Origin: "https://attacker.example" }, data: { action: "forget", connectionId: account.id } })).status()).toBe(403);
    const second = await db.business.create({ data: { organizationId, name: "Other fixture business" } });
    expect((await page.request.get(`/api/businesses/${second.id}/connections/data?connectionId=${account.id}`)).status()).toBe(404);
    await page.goto("/studio"); await page.getByRole("button", { name: "Connections", exact: true }).click();
    await page.getByRole("button", { name: "View saved data for Browser fixture page", exact: true }).click();
    const region = page.getByRole("region", { name: "Saved data for Browser fixture page", exact: true });
    await expect(region).toBeVisible(); await expect(region.getByText(snapshot.posts[0].text, { exact: true })).toBeVisible();
    await expect(region.getByText("0", { exact: true })).toBeVisible(); await expect(region.getByText("Not available", { exact: true })).toHaveCount(2);
    await expect(region.getByRole("link", { name: "View post on Facebook" })).toHaveAttribute("rel", "noopener noreferrer");
    await expect(page.getByRole("button", { name: "Refresh data for Browser fixture page", exact: true })).toBeDisabled();
    expect((await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole("region", { name: "Publishing connections" }).screenshot({ path: "../outputs/marketingbus-social-account-data.png" });
    const remove = page.getByRole("button", { name: "Remove saved data for Browser fixture page", exact: true });
    await remove.click(); await page.getByRole("button", { name: "Keep saved data", exact: true }).click(); await expect(remove).toBeFocused();
    await remove.click(); await page.getByRole("button", { name: "Confirm removal", exact: true }).click();
    await expect(page.getByText("Saved data removed. Remote posts and the connection are unchanged.", { exact: true })).toBeVisible();
    expect((await db.socialConnection.findUniqueOrThrow({ where: { id: account.id } })).dataSnapshot).toBeNull();
    await db.membership.updateMany({ where: { organizationId }, data: { role: "VIEWER" } });
    expect((await page.request.get(readUrl)).status()).toBe(200);
    expect((await page.request.post(endpoint, { headers, data: { action: "forget", connectionId: account.id } })).status()).toBe(403);
    const anonymous = await browser.newContext(); try { expect((await anonymous.request.get(`http://127.0.0.1:3000${readUrl}`)).status()).toBe(401); } finally { await anonymous.close(); }
    expect(await db.job.count({ where: { organizationId } })).toBe(0);
  } finally { if (organizationId) await db.organization.delete({ where: { id: organizationId } }); await db.user.deleteMany({ where: { email } }); }
});
