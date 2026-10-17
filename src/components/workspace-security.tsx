"use client";
import { useState } from "react";

export function WorkspaceSecurity({ organizationId, required, canManage, onSaved }: {
  organizationId: string; required: boolean; canManage: boolean; onSaved: () => void;
}) {
  const [password, setPassword] = useState(""), [code, setCode] = useState("");
  const [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [message, setMessage] = useState("");
  return <section className="panel" aria-busy={busy}>
    <h2>Workspace security</h2>
    <p>{required ? "Two-step verification is required for this workspace." : "Two-step verification is optional for this workspace."}</p>
    <p>Requiring MFA immediately blocks workspace access for members without an authenticator, including existing signed-in sessions. They can still verify their email, enroll in Account security and use unrelated workspaces. Already-authorized background jobs are not cancelled.</p>
    <p>Only an owner with verified email and an enabled authenticator can change this policy. Keep recovery codes safely outside the account. <a href="/account">Manage your authenticator</a>.</p>
    {canManage && <form onSubmit={async e => {
      e.preventDefault(); if (!confirmed || busy) return;
      setBusy(true); setError(""); setMessage("");
      try {
        const response = await fetch(`/api/workspaces/${organizationId}/security`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requireMfa: !required, expectedRequireMfa: required, password, code }),
        });
        const result = await response.json();
        if (!response.ok) throw Error(result.error || "Unable to update workspace security.");
        setPassword(""); setCode(""); setConfirmed(false);
        setMessage(result.requireMfa ? "Workspace MFA requirement enabled." : "Workspace MFA requirement removed. Existing authenticators stay enabled.");
        onSaved();
      } catch (err) { setError(err instanceof Error ? err.message : "Unable to update workspace security."); }
      finally { setBusy(false); setCode(""); }
    }}>
      <label>Owner password<input type="password" autoComplete="current-password" required minLength={12} maxLength={64} value={password} onChange={e => setPassword(e.target.value)} aria-describedby="workspace-security-error" /></label>
      <label>Owner authenticator or recovery code<input type="password" autoComplete="one-time-code" required minLength={6} maxLength={64} value={code} onChange={e => setCode(e.target.value)} aria-describedby="workspace-security-help workspace-security-error" /></label>
      <p id="workspace-security-help">Use a fresh code. A recovery code is consumed once. Your own MFA must be enabled even when removing the requirement.</p>
      <label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />{required ? "I understand this makes MFA optional for workspace access." : "I understand members without MFA will lose workspace access until they enroll."}</label>
      <button className="button dark" disabled={busy || !confirmed}>{busy ? "Saving security policy…" : required ? "Make workspace MFA optional" : "Require workspace MFA"}</button>
    </form>}
    <p id="workspace-security-error" role="alert" className="form-error">{error}</p>
    <p role="status">{message}</p>
  </section>;
}
