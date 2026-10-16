import { createHash } from "node:crypto";
import type { BillingOffer } from "./contracts";
export function billingTermsHash(offer: BillingOffer) {
  return createHash("sha256").update(JSON.stringify([offer.id, offer.name, offer.kind, offer.currency, offer.amountMinor, offer.generalCredits, offer.revisionCredits, offer.stripePriceId ?? null])).digest("hex");
}
