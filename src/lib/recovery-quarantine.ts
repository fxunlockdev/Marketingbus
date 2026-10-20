// Server-only deployment control. A misspelled configured value must not reopen a restore.
// This module deliberately has no database, credentials or provider dependencies.
export function recoveryQuarantined(value = process.env.RECOVERY_QUARANTINE): boolean {
  return value !== undefined && value !== "false";
}

export function quarantineResponse(): Response {
  return Response.json({ status: "unavailable", message: "Service temporarily unavailable." }, {
    status: 503,
    headers: {
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
