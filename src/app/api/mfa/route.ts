import { requireUser, rateLimit } from "@/lib/auth";
import { api, readBody } from "@/lib/http";
import { manageMfa, mfaStatus } from "@/lib/identity/mfa";
export async function GET() { return api(async () => mfaStatus((await requireUser()).id)); }
export async function POST(request: Request) { return api(async () => { const user = await requireUser(), input = await readBody(request); await rateLimit("mfa:manage", user.id, 10); return manageMfa(user.id, user.authVersion, input); }); }
