"use client";
import { useEffect, useState } from "react";
import { MfaSettings } from "./mfa-settings";
async function identityRequest(body: Record<string, string>) {
  const response = await fetch("/api/identity", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json(); if (!response.ok) throw Error(data.error || "Unable to process this request."); return data;
}
export function RecoveryForm() {
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  return <main className="auth-panel"><section className="auth-card"><h1>Recover your account</h1><p>Request a one-use link to choose a new password.</p>
    <form aria-busy={busy} onSubmit={async e => { e.preventDefault(); const data = new FormData(e.currentTarget); setBusy(true); setError(""); setNotice(""); try { const result = await identityRequest({ action: "request-reset", email: String(data.get("email")) }); setNotice(result.message); } catch (err) { setError(err instanceof Error ? err.message : "Request failed."); } finally { setBusy(false); } }}>
      <label>Email address<input type="email" name="email" required maxLength={254} autoComplete="email" aria-describedby="recovery-error" /></label>
      <p id="recovery-error" role={error ? "alert" : undefined} className="error">{error}</p><p role={notice ? "status" : undefined}>{notice}</p>
      <button className="button dark" disabled={busy}>{busy ? "Requesting…" : "Send recovery link"}</button>
    </form><p><a href="/login">Back to sign in</a></p></section></main>;
}
export function AccountLinkForm() {
  const [link, setLink] = useState<{ kind: string; token: string } | null>(null), [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [done, setDone] = useState("");
  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1)), kind = params.get("kind"), token = params.get("token");
    // Clear the address/history immediately; do not persist bearer tokens in browser storage.
    window.history.replaceState(null, "", "/account-link");
    if (["RESET_PASSWORD", "VERIFY_EMAIL"].includes(kind || "") && /^[A-Za-z0-9_-]{43}$/.test(token || "")) setLink({ kind: kind!, token: token! });
    setReady(true);
  }, []);
  const reset = link?.kind === "RESET_PASSWORD";
  return <main className="auth-panel"><section className="auth-card"><h1>{reset || done === "RESET_PASSWORD" ? "Choose a new password" : "Confirm your email"}</h1>
    {!ready ? <p role="status">Loading your link…</p> : done ? <p role="status">{done === "RESET_PASSWORD" ? "Password updated. All previous sessions have been signed out. Sign in with your new password." : "Email address verified. You can return to your workspace."}</p> : !link ? <p role="alert">This link is missing or invalid. Open the link from your email again, or request a new one.</p> : <form aria-busy={busy} onSubmit={async e => {
      e.preventDefault(); const data = new FormData(e.currentTarget); setError("");
      if (reset && data.get("password") !== data.get("confirmation")) { setError("The passwords do not match."); return; }
      setBusy(true); try { await identityRequest({ action: reset ? "reset" : "verify", token: link.token, ...(reset ? { password: String(data.get("password")) } : {}) }); setDone(link.kind); setLink(null); } catch (err) { setError(err instanceof Error ? err.message : "Request failed."); } finally { setBusy(false); }
    }}>
      {reset ? <><label>New password<input name="password" type="password" minLength={12} maxLength={64} required autoComplete="new-password" aria-describedby="link-help link-error" /></label><label>Confirm new password<input name="confirmation" type="password" minLength={12} maxLength={64} required autoComplete="new-password" aria-describedby="link-error" /></label><p id="link-help">At least 12 characters. Use a unique password.</p></> : <p>Confirm that you requested verification of this email address. Opening this page alone does not verify your account.</p>}
      <p id="link-error" role={error ? "alert" : undefined} className="error">{error}</p><button className="button dark" disabled={busy}>{busy ? "Saving…" : reset ? "Update password" : "Verify email address"}</button>
    </form>}
    <p><a href="/login">Back to sign in</a> · <a href="/account">Account settings</a></p>
  </section></main>;
}
export function AccountSettings({ email, verified, emailAvailable }: { email: string; verified: boolean; emailAvailable: boolean }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  return <main className="auth-panel"><section className="auth-card"><h1>Account security</h1><p>{email}</p><p>{verified ? "Email verified" : "Email not verified"}</p>
    {!verified && <button className="button secondary" disabled={busy || !emailAvailable} onClick={async () => { setBusy(true); setError(""); try { const result = await identityRequest({ action: "request-verification" }); setNotice(result.message); } catch (e) { setError(e instanceof Error ? e.message : "Request failed."); } finally { setBusy(false); } }}>Send verification link</button>}
    {!emailAvailable && <p>Email delivery is not configured yet. Verification and password recovery require the workspace operator to activate Resend.</p>}
    <p role={error ? "alert" : undefined} className="error">{error}</p><p role={notice ? "status" : undefined}>{notice}</p>
    <p><a href="/recover">Reset your password</a></p><MfaSettings /><a href="/studio">Return to studio</a>
  </section></main>;
}
