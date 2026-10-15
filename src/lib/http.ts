import { NextResponse } from "next/server";
import { ZodError } from "zod";
export class AppError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export function checkOrigin(request: Request) {
  const expected = process.env.APP_ORIGIN;
  if (!expected) throw new AppError(503, "Application origin is not configured.");
  if (request.headers.get("origin") !== new URL(expected).origin) throw new AppError(403, "Request origin not allowed.");
}
export async function readBody(request: Request) {
  checkOrigin(request);
  // Count actual streamed bytes, not only an attacker-controlled Content-Length.
  const reader = request.body?.getReader();
  if (!reader) throw new AppError(400, "A request body is required.");
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const part = await reader.read(); if (part.done) break;
    size += part.value.byteLength;
    if (size > 32_768) { await reader.cancel(); throw new AppError(413, "Please shorten this submission."); }
    chunks.push(part.value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new AppError(400, "Invalid JSON."); }
}
export async function api(run: () => Promise<unknown>) {
  const headers = { "Cache-Control": "no-store" };
  try { return NextResponse.json(await run(), { headers }); }
  catch (error) {
    if (error instanceof ZodError) return NextResponse.json({ error: error.issues[0]?.message ?? "Check the form." }, { status: 400, headers });
    if (error instanceof AppError) return NextResponse.json({ error: error.message }, { status: error.status, headers });
    console.error("Request failed", error instanceof Error ? error.name : "UnknownError");
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500, headers });
  }
}
