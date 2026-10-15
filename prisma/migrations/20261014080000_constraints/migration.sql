ALTER TABLE "Wallet" ADD CONSTRAINT "wallet_nonnegative" CHECK ("available" >= 0 AND "held" >= 0);
ALTER TABLE "Reservation" ADD CONSTRAINT "reservation_positive" CHECK (credits > 0);
ALTER TABLE "CreditEntry" ADD CONSTRAINT "entry_nonnegative" CHECK (amount >= 0);
ALTER TABLE "Job" ADD CONSTRAINT "job_business_scope" FOREIGN KEY ("businessId", "organizationId") REFERENCES "Business"(id,"organizationId");
ALTER TABLE "Membership" ADD CONSTRAINT "membership_role" CHECK (role IN ('OWNER','ADMIN','EDITOR','REVIEWER','VIEWER'));
