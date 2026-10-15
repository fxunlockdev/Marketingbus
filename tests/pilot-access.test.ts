import { describe, expect, it } from "vitest";
import { requirePilotInvitation } from "../src/lib/pilot-access";
describe("private pilot registration", () => {
 const code = "test-only-invitation-of-sufficient-length";
 it("allows unconfigured loopback development", () => expect(() => requirePilotInvitation(undefined, {APP_ORIGIN:"http://127.0.0.1:3000"})).not.toThrow());
 it("fails closed on hosted deployments", () => expect(() => requirePilotInvitation(undefined, {APP_ORIGIN:"https://app.example"})).toThrow("not configured"));
 it("does not treat a Railway origin misconfiguration as local", () => expect(() => requirePilotInvitation(undefined, {APP_ORIGIN:"http://127.0.0.1:3000",RAILWAY_ENVIRONMENT_ID:"hosted"})).toThrow("not configured"));
 it("rejects wrong or missing invitations", () => {
  for(const value of [undefined,"incorrect"]) expect(() => requirePilotInvitation(value,{PILOT_INVITE_CODE:code})).toThrow("invitation code");
 });
 it("accepts the configured invitation", () => expect(() => requirePilotInvitation(code,{PILOT_INVITE_CODE:code})).not.toThrow());
});
