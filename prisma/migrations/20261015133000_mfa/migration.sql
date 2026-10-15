CREATE TABLE "MfaCredential" (
 "userId" TEXT PRIMARY KEY, "encryptedSecret" TEXT NOT NULL DEFAULT '', "pendingSecret" TEXT NOT NULL DEFAULT '',
 "pendingExpiresAt" TIMESTAMP(3), "enabledAt" TIMESTAMP(3), "lastStep" INTEGER NOT NULL DEFAULT -1,
 "recoveryHashes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
 CONSTRAINT "MfaCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
