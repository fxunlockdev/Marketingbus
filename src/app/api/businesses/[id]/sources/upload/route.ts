import { requireBusiness, rateLimit } from "@/lib/auth";
import { api, AppError, checkOrigin } from "@/lib/http";
import { manageSource } from "@/lib/knowledge/service";
import { DOCUMENT_BYTE_LIMIT, extractDocument } from "@/lib/knowledge/documents";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    checkOrigin(request);
    const { id } = await context.params, { user, business } = await requireBusiness(id, true);
    if (request.headers.get("x-content-rights") !== "confirmed") throw new AppError(400, "Confirm permission to import this content.");
    await rateLimit("document:parse:user", user.id, 12);
    await rateLimit("document:parse:workspace", business.organizationId, 30);
    const name = request.headers.get("x-document-name") || "";
    if (!/^[^/\\\u0000-\u001f]{1,120}\.(pdf|docx|pptx|txt|md)$/i.test(name)) throw new AppError(400, "Choose a PDF, Word, PowerPoint or text file.");
    const kind = name.toLowerCase().split(".").pop()!;
    const reader = request.body?.getReader(); if (!reader) throw new AppError(400, "Upload a document.");
    let size = 0; const chunks: Uint8Array[] = [];
    while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > DOCUMENT_BYTE_LIMIT) { await reader.cancel(); throw new AppError(413, "Use a document up to 5 MB."); } chunks.push(part.value); }
    const bytes = Buffer.concat(chunks);
    let text: string;
    if (kind === "txt" || kind === "md") {
      if (bytes.length > 24000) throw new AppError(413, "Use a text file up to 24 KB.");
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { throw new AppError(422, "Save this file as UTF-8 text and try again."); }
    } else text = await extractDocument(bytes, kind as "pdf" | "docx" | "pptx");
    await requireBusiness(id, true); // Recheck access after the bounded parser runs.
    // Store reviewed text only. Original binaries, macros and embedded images are not retained.
    return manageSource({ businessId: id, organizationId: business.organizationId, actorId: user.id }, { action: "document", title: name.slice(0, 120), text, rightsConfirmed: true });
  });
}
