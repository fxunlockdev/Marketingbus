import { createHash } from "node:crypto";
import { publicationPayload } from "./contracts";
export const MAX_RECONCILIATION_ATTEMPTS = 5;

export function validCandidateId(provider: string, id: string, accountId: string) {
  if (provider === "LinkedIn") return /^urn:li:(share|ugcPost):[1-9][0-9]{0,30}$/.test(id);
  if (provider === "Facebook") return /^[1-9][0-9]{0,39}_[1-9][0-9]{0,39}$/.test(id) && id.startsWith(`${accountId}_`);
  return false;
}

export function payloadHash(raw: unknown) {
  return createHash("sha256").update(JSON.stringify(publicationPayload.parse(raw))).digest("hex");
}

// Validate persisted data as untrusted input at both write and read-back boundaries.
// Media delivery needs its own immutable-export contract before it can be enabled.
export function frozenCopy(raw: unknown, hash: string, provider: string) {
  const payload = publicationPayload.parse(raw);
  if (payloadHash(payload) !== hash || payload.channel !== provider ||
      payload.format !== "static" || provider === "Instagram") {
    throw Error("Publication snapshot is invalid or unsupported");
  }
  return payload;
}
