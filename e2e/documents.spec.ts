import { test, expect } from "@playwright/test";
import JSZip from "jszip";
test("Word upload is reviewed evidence, deduplicates, rejects malformed data and remains tenant scoped", async ({ page, playwright }) => {
  const headers = { Origin: "http://127.0.0.1:3000" };
  expect((await page.request.post("/api/auth/register", { headers, data: { name: "Document browser fixture", email: `document-${crypto.randomUUID()}@example.test`, password: "Test-only-password-2026!" } })).ok()).toBe(true);
  const response = await page.request.post("/api/businesses", { headers, data: { name: "Document Studio", offering: "Design consultations", audience: "Homeowners", goal: "Book consultations" } });
  expect(response.ok()).toBe(true); const { id } = await response.json();
  const zip = new JSZip(), evidence = "Our architecture studio offers considered design consultations for homeowners.";
  zip.file("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file("word/document.xml", `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${evidence}</w:t></w:r></w:p></w:body></w:document>`);
  const bytes = await zip.generateAsync({ type: "nodebuffer" });
  await page.goto("/studio"); await page.getByRole("button", { name: "Brand", exact: true }).click();
  await page.getByLabel("I have permission to import this business content.").check();
  await page.getByLabel("PDF or Word document (.pdf or .docx, up to 5 MB)").setInputFiles({ name: "Brand evidence.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: bytes });
  await page.getByRole("button", { name: "Extract document for review", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Brand evidence.docx", exact: true })).toBeVisible();
  const source = page.locator("article").filter({ has: page.getByRole("heading", { name: "Brand evidence.docx", exact: true }) });
  await expect(source.getByText("Text document · proposed", { exact: true })).toBeVisible();
  await source.getByText("Read source text", { exact: true }).click(); await expect(source.getByText(evidence, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Extract document for review", exact: true }).click();
  await expect(page.getByText("Matching extracted text already exists. No duplicate source was stored.", { exact: true })).toBeVisible();
  const uploadHeaders = { ...headers, "x-content-rights": "confirmed", "x-document-name": "Broken.pdf", "Content-Type": "application/octet-stream" };
  expect((await page.request.post(`/api/businesses/${id}/sources/upload`, { headers: uploadHeaders, data: "not a PDF" })).status()).toBe(422);
  const other = await playwright.request.newContext({ baseURL: "http://127.0.0.1:3000" });
  try {
    await other.post("/api/auth/register", { headers, data: { name: "Other tenant", email: `document-other-${crypto.randomUUID()}@example.test`, password: "Test-only-password-2026!" } });
    expect((await other.post(`/api/businesses/${id}/sources/upload`, { headers: uploadHeaders, data: bytes })).status()).toBe(404);
  } finally { await other.dispose(); }
  await page.getByRole("button", { name: "Delete source · Brand evidence.docx", exact: true }).click();
  await page.getByRole("button", { name: "Confirm source deletion", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Brand evidence.docx", exact: true })).toHaveCount(0);
});
