"use client";
import { useEffect, useRef, useState } from "react";
import { SocialAccountData } from "./social-account-data";
type View = {
  canManage: boolean; enabledProviders: string[]; dataEnabledProviders: string[];
  connections: { id: string; provider: string; label: string; status: string; authorizationVersion: number; expiresAt: string | null; dataFetchedAt: string | null; dataAttemptedAt: string | null; dataLeaseUntil: string | null; dataErrorCode: string | null }[];
  flows: { id: string; provider: string; status: string; expiresAt: string; choices: { choiceId: string; label: string }[] }[];
};
export function SocialConnections({ businessId }: { businessId: string }) {
  const [view, setView] = useState<View | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const resultRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (message) resultRef.current?.focus(); }, [message]);
  const endpoint = `/api/businesses/${businessId}/connections`;
  async function reload() {
    const response = await fetch(endpoint, { cache: "no-store" }), result = await response.json();
    if (!response.ok) throw Error(result.error || "Connections could not be loaded.");
    setView(result);
  }
  useEffect(() => {
    const controller = new AbortController();
    setView(null); setError(""); setMessage("");
    fetch(endpoint, { cache: "no-store", signal: controller.signal }).then(async response => {
      const result = await response.json(); if (!response.ok) throw Error(result.error || "Connections could not be loaded."); setView(result);
    }).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [endpoint]);
  async function act(input: { action: string; [key: string]: unknown }) {
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }), result = await response.json();
      if (!response.ok) throw Error(result.error || "This connection could not be updated.");
      if (result.authorizationUrl) { window.location.assign(result.authorizationUrl); return; }
      await reload();
      if (input.action === "disconnect") setMessage("Account disconnected from Marketingbus. Saved credentials were removed and queued posts cancelled. Previously sent or uncertain posts were not deleted; review those on the network. Revoke the app in the network’s settings to remove its remote authorization.");
    } catch (error) { setError(error instanceof Error ? error.message : "Please try again."); }
    finally { setBusy(false); }
  }
  return <section className="panel" aria-label="Publishing connections" aria-busy={busy}>
    <h2>Social accounts</h2>
    <p className="muted">Connect a destination, then choose the account for this business. Connecting does not publish anything or approve your work.</p>
    {error && <p role="alert">{error}</p>}
    <p role="status" tabIndex={-1} ref={resultRef}>{message}</p>
    {!view && !error && <p role="status">Loading destinations…</p>}
    {view && <>
      {!view.canManage && <p>Only a workspace owner or admin can manage connections.</p>}
      <div className="tag-row">{["Instagram", "Facebook", "LinkedIn"].map(provider => <div key={provider}>
        <button className="button secondary" disabled={busy || !view.canManage || !view.enabledProviders.includes(provider)} onClick={() => act({ action: "begin", provider })}>Connect {provider}</button>
        {!view.enabledProviders.includes(provider) && <p className="muted">{provider}: platform setup pending</p>}
      </div>)}</div>
      <p className="muted">X and YouTube are planned destinations and are not available yet.</p>
      <p className="muted" id="disconnect-explanation">Disconnecting removes this business’s saved credentials, stops metric checks and cancels queued posts and pending connection requests for that platform. Requests already sent may still finish. Published posts, uncertain outcomes and audit history remain. This does not revoke the app in the network’s settings.</p>
      {view.connections.length === 0 ? <p>No accounts connected for this business.</p> : <ul>{view.connections.map(account => {
        const expired = account.status === "CONNECTED" && !!account.expiresAt && Date.parse(account.expiresAt) <= Date.now();
        const reconnect = expired || account.status === "RECONNECT_REQUIRED";
        const expiring = account.status === "CONNECTED" && !!account.expiresAt && !expired && Date.parse(account.expiresAt) <= Date.now() + 7 * 86400000;
        return <li key={account.id}>
        {account.provider} · {account.label} · {reconnect ? "Reconnect required" : account.status.toLowerCase()}
        {(reconnect || expiring) && <div>
          <p id={`access-${account.id}`} className="muted">{reconnect
            ? "Account access has ended. New publishing and data reads are blocked. Background cleanup removes saved credentials and cancels queued posts; requests already sent may still finish. Reconnecting does not restart cancelled posts or uncertain lookups."
            : `Account access expires ${new Date(account.expiresAt!).toLocaleString()}. Renew before then to avoid interrupted publishing.`} Choose the same account during authorization. Previously published posts remain on the network.</p>
          {view.canManage ? <button className="button secondary" aria-describedby={`access-${account.id}`} disabled={busy || !view.enabledProviders.includes(account.provider)}
            onClick={() => act({ action: "begin", provider: account.provider })}>{reconnect ? "Reconnect" : "Renew access for"} {account.label}</button>
            : <p className="muted">Ask a workspace owner or admin to reconnect this account.</p>}
          {!view.enabledProviders.includes(account.provider) && <p className="muted">Reconnection is unavailable until platform setup is enabled.</p>}
        </div>}
        {view.canManage && account.status !== "DISCONNECTED" && <button className="button secondary" disabled={busy} aria-describedby="disconnect-explanation" onClick={() => {
          if (window.confirm(`Disconnect ${account.label} from this business? Queued posts and pending ${account.provider} connection requests will be cancelled. Already-sent requests may still finish. Remote posts and authorization will not be removed.`))
            void act({ action: "disconnect", connectionId: account.id, authorizationVersion: account.authorizationVersion });
        }}>Disconnect {account.label}</button>}
        <SocialAccountData businessId={businessId} account={account} canManage={view.canManage} enabled={view.dataEnabledProviders?.includes(account.provider) ?? false} onChanged={reload} />
      </li>; })}</ul>}
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
