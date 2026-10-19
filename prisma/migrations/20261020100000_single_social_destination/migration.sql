-- Preserve disconnected account history and publication references. Never silently
-- remove an existing grant: pre-existing duplicates cause migration to fail safely.
CREATE UNIQUE INDEX "SocialConnection_one_live_destination"
ON "SocialConnection" ("businessId", "provider")
WHERE "status" <> 'DISCONNECTED';
