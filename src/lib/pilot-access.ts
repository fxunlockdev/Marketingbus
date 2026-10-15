import { createHash, timingSafeEqual } from "node:crypto";
import { AppError } from "./http";

/** Hosted registration fails closed. Local development needs no invitation. */
export function requirePilotInvitation(code: string | undefined, env: Record<string, string | undefined> = process.env) {
  const expected = env.PILOT_INVITE_CODE;
  const origin = env.APP_ORIGIN;
  const local = origin && ["http://localhost:3000", "http://127.0.0.1:3000"].includes(origin);
  if (!expected && local && !env.RAILWAY_ENVIRONMENT_ID) return;
  if (!expected || expected.length < 24) throw new AppError(503, "Pilot registration is not configured yet.");
  const digest = (value: string) => createHash("sha256").update(value).digest();
  if (!timingSafeEqual(digest(code ?? ""), digest(expected))) {
    throw new AppError(403, "A valid private-pilot invitation code is required.");
  }
}
