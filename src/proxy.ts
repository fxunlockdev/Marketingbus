import { NextResponse } from "next/server";
import { quarantineResponse, recoveryQuarantined } from "./lib/recovery-quarantine";

// No matcher exclusions: callbacks, webhooks, media, server actions and static pages
// must all remain inaccessible on a quarantined recovery deployment.
export function proxy() {
  return recoveryQuarantined() ? quarantineResponse() : NextResponse.next();
}
