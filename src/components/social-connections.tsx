"use client";
import { useEffect, useState } from "react";
type View = {
  canManage: boolean; enabledProviders: string[];
  connections: { id: string; provider: string; label: string; status: string; expiresAt: string | null }[];
  flows: { id: string; provider: string; status: string; expiresAt: string; choices: { choiceId: string; label: string }[] }[];
};
export function SocialConnections({ businessId }: { businessId: string }) {
  const [view, setView] = useState<View | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const endpoint = `/api/businesses/${businessId}/connections`;
  async function reload() {
    const response = await fetch(endpoint, { cache: "no-store" }), result = await response.json();
    if (!response.ok) throw Error(result.error || "Connections could not be loaded.");
    setView(result);
  }
  useEffect(() => {
    const controller = new AbortController();
    fetch(endpoint, { cache: "no-store", signal: controller.signal }).then(async response => {
      const result = await response.json(); if (!response.ok) throw Error(result.error || "Connections could not be loaded."); setView(result);
    }).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [endpoint]);
  async function act(input: object) {
    setBusy(true); setError("");
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }), result = await response.json();
      if (!response.ok) throw Error(result.error || "This connection could not be updated.");
      if (result.authorizationUrl) { window.location.assign(result.authorizationUrl); return; }
      await reload();
    } catch (error) { setError(error instanceof Error ? error.message : "Please try again."); }
    finally { setBusy(false); }
  }
  return <section className="panel" aria-label="Publishing connections" aria-busy={busy}>
    <h2>Social accounts</h2>
    <p className="muted">Connect a destination, then choose the account for this business. Connecting does not publish anything or approve your work.</p>
    {error && <p role="alert">{error}</p>}
    {!view && !error && <p role="status">Loading destinations…</p>}
    {view && <>
      {!view.canManage && <p>Only a workspace owner or admin can manage connections.</p>}
      <div className="tag-row">{["Instagram", "Facebook", "LinkedIn"].map(provider => <div key={provider}>
        <button className="button secondary" disabled={busy || !view.canManage || !view.enabledProviders.includes(provider)} onClick={() => act({ action: "begin", provider })}>Connect {provider}</button>
        {!view.enabledProviders.includes(provider) && <p className="muted">{provider}: platform setup pending</p>}
      </div>)}</div>
      <p className="muted">X and YouTube are planned destinations and are not available yet.</p>
      {view.connections.length === 0 ? <p>No accounts connected for this business.</p> : <ul>{view.connections.map(account => <li key={account.id}>
        {account.provider} · {account.label} · {account.status === "CONNECTED" && account.expiresAt && new Date(account.expiresAt) <= new Date() ? "Reconnect required" : account.status.toLowerCase()}
      </li>)}</ul>}
      {view.flows.map(flow => <article key={flow.id} className="panel" aria-label={`${flow.provider} connection request`}>
        <h3>{flow.provider} connection request</h3>
        {flow.status === "CHOOSING" ? <>
          <p>Choose one account to connect to this business. Temporary authorization expires at {new Date(flow.expiresAt).toLocaleTimeString()}.</p>
          {flow.choices.map(choice => <button className="button secondary" key={choice.choiceId} disabled={busy || !view.enabledProviders.includes(flow.provider)} onClick={() => act({ action: "choose", flowId: flow.id, choiceId: choice.choiceId })}>Connect {choice.label}</button>)}
          {(!flow.choices.length || !view.enabledProviders.includes(flow.provider)) && <p>Account selection is unavailable. Cancel this request and start again when the destination is enabled.</p>}
        </> : <p>{({ PENDING: "Waiting for authorization. You can cancel and start again.", EXCHANGING: "Authorization is being checked. Refresh to see the result; do not submit again.", CONNECTED: "Account connected. Nothing has been published.", CANCELLED: "Connection request cancelled.", FAILED: "Authorization was not completed. Start a new connection request." } as Record<string, string>)[flow.status] || "This request has expired. Start again."}</p>}
        {["PENDING", "EXCHANGING", "CHOOSING"].includes(flow.status) && <button className="button secondary" disabled={busy} onClick={() => act({ action: "cancel", flowId: flow.id })}>Cancel connection request</button>}
      </article>)}
      <button className="button secondary" disabled={busy} onClick={async () => { setBusy(true); setError(""); try { await reload(); } catch (error) { setError(error instanceof Error ? error.message : "Please try again."); } finally { setBusy(false); } }}>Refresh connections</button>
    </>}
  </section>;
}
