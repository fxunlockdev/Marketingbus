import { redirect } from "next/navigation";
import { session } from "@/lib/auth";
import { emailConfiguration } from "@/lib/identity/service";
import { AccountSettings } from "@/components/identity-forms";
export default async function Account() {
  const user = await session(); if (!user) redirect("/login");
  let emailAvailable = false; try { emailConfiguration(); emailAvailable = true; } catch { /* Fail closed. */ }
  return <AccountSettings email={user.email} verified={!!user.emailVerifiedAt} emailAvailable={emailAvailable} />;
}
