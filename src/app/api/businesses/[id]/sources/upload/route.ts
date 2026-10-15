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
    if (!/^[^/\\\u0000-\u001f]{2,120}\.(pdf|docx)$/i.test(name)) throw new AppError(400, "Use a PDF or DOCX filename up to 125 characters.");
    const kind = name.toLowerCase().endsWith(".pdf") ? "pdf" : "docx";
    const reader = request.body?.getReader(); if (!reader) throw new AppError(400, "Upload a document.");
    let size = 0; const chunks: Uint8Array[] = [];
    while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > DOCUMENT_BYTE_LIMIT) { await reader.cancel(); throw new AppError(413, "Use a document up to 5 MB."); } chunks.push(part.value); }
    const text = await extractDocument(Buffer.concat(chunks), kind);
    await requireBusiness(id, true); // Recheck access after the bounded parser runs.
    // Store reviewed text only. Original binaries, macros and embedded images are not retained.
    return manageSource({ businessId: id, organizationId: business.organizationId, actorId: user.id }, { action: "document", title: name.slice(0, 120), text, rightsConfirmed: true });
  });
}
