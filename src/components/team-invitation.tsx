"use client";
import { useEffect, useRef, useState } from "react";
type Preview = { workspace: string; role: string; expiresAt: string };
type Identity = { email: string; verified: boolean };
export function AcceptTeamInvitation() {
  const captured = useRef<string | null>(null);
  const [token, setToken] = useState(""), [preview, setPreview] = useState<Preview | null>(null), [identity, setIdentity] = useState<Identity | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [register, setRegister] = useState(true), [error, setError] = useState(""), [done, setDone] = useState(false);
  async function loadIdentity(signal?: AbortSignal) {
    const response = await fetch("/api/identity", { signal });
    if (response.status === 401) { setIdentity(null); return; }
    const data = await response.json(); if (!response.ok) throw Error(data.error);
    if (!signal?.aborted) setIdentity(data);
  }
  useEffect(() => {
    if (captured.current === null) {
      captured.current = new URLSearchParams(location.hash.slice(1)).get("token") || "";
      history.replaceState(null, "", location.pathname);
    }
    const raw = captured.current, abort = new AbortController(); setToken(raw);
    void (async () => {
      try {
        if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) throw Error("Reopen the full invitation link from your email. No invitation has been accepted.");
        const response = await fetch("/api/team-invitations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "preview", token: raw }), signal: abort.signal });
        const data = await response.json(); if (!response.ok) throw Error(data.error);
        if (!abort.signal.aborted) setPreview(data);
        await loadIdentity(abort.signal);
      } catch (e) { if (!abort.signal.aborted) setError(e instanceof Error ? e.message : "Unable to inspect invitation."); }
      finally { if (!abort.signal.aborted) setLoading(false); }
    })();
    return () => abort.abort();
  }, []);
  function completed() { setDone(true); setToken(""); captured.current = ""; }
  async function action(kind: "accept" | "logout" | "refresh") {
    setBusy(true); setError("");
    try {
      if (kind === "refresh") { await loadIdentity(); return; }
      const response = await fetch(kind === "accept" ? "/api/team-invitations" : "/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(kind === "accept" ? { token } : {}) });
      const data = await response.json(); if (!response.ok) throw Error(data.error);
      if (kind === "accept") completed(); else setIdentity(null);
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to update invitation."); }
    finally { setBusy(false); }
  }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget, values = new FormData(form); setBusy(true); setError("");
    try {
      const response = await fetch(`/api/auth/${register ? "register" : "login"}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: values.get("email"), password: values.get("password"), ...(register ? { name: values.get("name"), teamInvitationToken: token } : { code: values.get("code") || "" }) }) });
      const data = await response.json(); if (!response.ok) throw Error(data.error);
      form.reset(); if (register) completed(); else await loadIdentity();
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to continue. If your account was created, sign in to recover access."); }
    finally { setBusy(false); }
  }
  return <main className="auth-card" aria-busy={busy || loading}>
    <h1>Workspace invitation</h1>
    {loading && <p role="status">Checking invitation…</p>}
    <p id="invitation-error" role="alert" className="form-error">{error}</p>
    {done ? <p role="status">You joined {preview?.workspace}. <a href="/studio">Open your workspace</a></p> : preview && !loading ? <>
      <h2>Join {preview.workspace}</h2>
      <p>Invited access: {preview.role.toLowerCase()}. Membership applies to this workspace’s businesses. Expires {new Date(preview.expiresAt).toLocaleString()}.</p>
      <p>Opening this link does not join the workspace. Only the email address that received the invitation can use it.</p>
      {identity ? <>
        <p>Signed in as {identity.email}.</p>
        {!identity.verified && <p>Verify this account’s email before accepting. <a href="/account" target="_blank" rel="noopener noreferrer">Open email verification in a new tab</a>, then check your status here.</p>}
        <div className="tag-row">
          <button className="button dark" disabled={busy || !identity.verified} onClick={() => action("accept")}>Accept workspace invitation</button>
          {!identity.verified && <button className="button" disabled={busy} onClick={() => action("refresh")}>Check verification status</button>}
          <button className="button" disabled={busy} onClick={() => action("logout")}>Use a different account</button>
        </div>
      </> : <>
        <h3>{register ? "Create your account and join" : "Sign in to review the invitation"}</h3>
        <form onSubmit={submit} aria-describedby="invitation-error">
          <fieldset disabled={busy}><legend>{register ? "New account details" : "Existing account details"}</legend>
            {register && <label>Your name<input name="name" required minLength={2} maxLength={80} autoComplete="name" /></label>}
            <label>Invited email address<input name="email" type="email" required maxLength={254} autoComplete="email" /></label>
            <label>Password<input name="password" type="password" required minLength={12} maxLength={64} autoComplete={register ? "new-password" : "current-password"} aria-describedby="invite-password-help" /></label>
            <p id="invite-password-help">Use at least 12 characters. Existing accounts must sign in; this invitation cannot reset a password or bypass an authenticator.</p>
            {!register && <label>Authenticator or recovery code (if enabled)<input name="code" maxLength={64} autoComplete="one-time-code" /></label>}
            {register && <p>This emailed link verifies the invited address when you create the account. It grants only the access shown above; it does not create another workspace or add credits.</p>}
            <button className="button dark" disabled={busy}>{register ? "Create account and join workspace" : "Sign in to continue"}</button>
          </fieldset>
        </form>
        <button className="text-button" disabled={busy} onClick={() => { setRegister(v => !v); setError(""); }}>{register ? "Already have an account? Sign in" : "New here? Create an invited account"}</button>
        <p><a href="/recover" target="_blank" rel="noopener noreferrer">Recover your password in a new tab</a></p>
      </>}
    </> : !loading && <p>Ask your workspace administrator for a current invitation. <a href="/login">Return to sign in</a>.</p>}
    {!done && <p>The invitation stays only in this page’s memory. If you reload or close it, reopen the original email link.</p>}
  </main>;
}
