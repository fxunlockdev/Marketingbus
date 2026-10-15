import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import AxeBuilder from "@axe-core/playwright";
const local = process.env.TEST_DATABASE_URL;
test.skip(!local, "Requires explicit localhost fixture database.");
if (
  local &&
  (process.env.DATABASE_URL !== local ||
    !["127.0.0.1", "localhost"].includes(new URL(local).hostname))
)
  throw Error("Refusing non-local fixture writes");
const db = new PrismaClient();
test.afterAll(async () => db.$disconnect());
test("compose, preview, approve, export; honest analytics and owner protections", async ({
  page,
}) => {
  const email = `workflow-${crypto.randomUUID()}@example.test`,
    headers = { Origin: "http://127.0.0.1:3000" };
  let organizationId: string | undefined;
  try {
    expect(
      (
        await page.request.post("/api/auth/register", {
          headers,
          data: {
            name: "Workflow Fixture",
            email,
            password: "Test-only-password-2026!",
          },
        })
      ).ok()
    ).toBe(true);
    const created = await page.request.post("/api/businesses", {
      headers,
      data: {
        name: "Studio",
        offering: "Architecture consultations",
        audience: "Homeowners",
        goal: "Book consultations",
        channels: ["Facebook"],
      },
    });
    expect(created.ok()).toBe(true);
    const { id } = await created.json();
    organizationId = (await db.business.findUniqueOrThrow({ where: { id } }))
      .organizationId;
    await page.request.post(`/api/businesses/${id}`, {
      headers,
      data: { action: "confirm", version: 1 },
    });
    await page.request.post(`/api/businesses/${id}`, {
      headers,
      data: { action: "plan", version: 1 },
    });
    const item = await db.productionItem.findFirstOrThrow({
      where: { plan: { businessId: id } },
    });
    await db.creativeRevision.create({
      data: {
        itemId: item.id,
        organizationId,
        version: 1,
        status: "APPROVED",
        content: {
          headline: "Made for home",
          caption: "Considered architecture for your home.",
          cta: "Meet us",
          visualDirection: "Approved typography",
          rationale: "Test fixture, not AI output",
          evidenceUsed: [],
        },
      },
    });
    await page.goto("/studio");
    await page
      .getByRole("button", { name: "Design studio", exact: true })
      .click();
    await page.getByLabel("Creative", { exact: true }).selectOption(item.id);
    await page
      .getByRole("button", { name: "Use approved brand assets" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Editable layout · version 1" })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Download PNG" })
    ).toBeDisabled();
    await page.getByRole("button", { name: "Render saved preview" }).click();
    const image = page.getByAltText(
      "Saved composition preview for visual review"
    );
    await expect(image).toBeVisible();
    await expect
      .poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth))
      .toBe(1080);
    await page
      .getByRole("button", { name: "Approve saved composition" })
      .click();
    await expect(
      page.getByRole("button", { name: "Download PNG" })
    ).toBeEnabled();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download PNG" }).click();
    expect((await download).suggestedFilename()).toBe("creative-square.png");
    const savedExports = page.getByRole("region", { name: "Saved publishing exports" });
    await expect(savedExports.getByRole("button", { name: "Save approved square export" })).toBeEnabled();
    if (!process.env.ASSET_S3_ENDPOINT) {
      await savedExports.getByRole("button", { name: "Save approved square export" }).click();
      await expect(savedExports.getByRole("alert")).toContainText("storage is not configured");
      expect((await (await page.request.get(`/api/businesses/${id}/exports`)).json()).exports).toEqual([]);
    }
    await page.getByLabel("Background colour", { exact: true }).fill("#eeeeee");
    await page
      .getByRole("button", { name: "Save layout version · no credits" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Editable layout · version 2" })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Download PNG" })
    ).toBeDisabled();
    await page.getByRole("button", { name: "Render saved preview" }).click();
    await expect(image).toBeVisible();
    expect(
      (
        await new AxeBuilder({ page })
          .include("main")
          .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
          .analyze()
      ).violations
    ).toEqual([]);
    await page.screenshot({
      path: "../outputs/marketingbus-design-studio.png",
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Publishing & analytics", exact: true })
      .click();
    await expect(
      page.getByText(
        "No verified performance data yet. Connect accounts and publish before drawing conclusions."
      )
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Schedule social publication" })
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "Evaluate available evidence" })
      .click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText(
      "Insufficient comparable evidence"
    );
    const response = await page.request.get(`/api/businesses/${id}/social`);
    expect(response.headers()["cache-control"]).toBe("no-store");
    expect((await response.json()).summary).toHaveLength(0);
    expect(
      (
        await new AxeBuilder({ page })
          .include("main")
          .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
          .analyze()
      ).violations
    ).toEqual([]);
    await page.getByRole("button", { name: "Team", exact: true }).click();
    await expect(
      page.getByRole("heading", {
        name: "Workspace team",
        exact: true,
        level: 1,
      })
    ).toBeVisible();
    page.on("dialog", (dialog) => dialog.accept());
    await page
      .getByRole("button", { name: "Remove Workflow Fixture", exact: true })
      .click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText(
      "last workspace owner"
    );
    expect(
      (
        await new AxeBuilder({ page })
          .include("main")
          .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
          .analyze()
      ).violations
    ).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth
      )
    ).toBe(true);
    await db.membership.updateMany({
      where: { organizationId },
      data: { role: "VIEWER" },
    });
    expect(
      (
        await page.request.post(`/api/businesses/${id}/compositions`, {
          headers,
          data: { action: "create", itemId: item.id, revisionVersion: 1 },
        })
      ).status()
    ).toBe(404);
    expect(
      (
        await page.request.post(`/api/workspaces/${organizationId}/team`, {
          headers,
          data: {
            action: "invite",
            email: "someone@example.test",
            role: "EDITOR",
          },
        })
      ).status()
    ).toBe(403);
    expect(await db.job.count({ where: { organizationId } })).toBe(0);
  } finally {
    if (organizationId)
      await db.compositionExport.deleteMany({ where: { organizationId } });
    if (organizationId)
      await db.organization.delete({ where: { id: organizationId } });
    await db.user.deleteMany({ where: { email } });
  }
});
