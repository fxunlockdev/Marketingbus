"use client";
import { Facebook, Instagram, Linkedin, ArrowRight } from "lucide-react";
import { useId, useRef, useState } from "react";
export function DestinationCatalogue({ onSetup, workspaces, onCreated }: { onSetup: () => void; workspaces: { id: string; name: string }[]; onCreated: (id: string) => void }) {
  const uid = useId(), requestId = useRef("");
  const [organizationId, setOrganizationId] = useState(workspaces[0]?.id ?? ""), [name, setName] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const destinations = [
    { name: "Instagram", Icon: Instagram, account: "Professional account linked to a Facebook Page", formats: "Image posts and Reels" },
    { name: "Facebook", Icon: Facebook, account: "Facebook Page you manage", formats: "Page posts, images and Reels" },
    { name: "LinkedIn", Icon: Linkedin, account: "Company Page you administer", formats: "Company posts, images and video" },
  ];
  return <section aria-label="Publishing destination catalogue">
    <div className="destination-setup"><div><h2>Connect now. Complete your brand later.</h2><p>Give this business a name to keep its accounts separate. You can connect one account per platform before completing your website and brand profile.</p></div><button className="button secondary" onClick={onSetup}>Set up your business <ArrowRight size={16} aria-hidden="true" /></button></div>
    <form className="panel" aria-label="Connect before brand setup" aria-busy={busy} onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError("");
      try {
        requestId.current ||= crypto.randomUUID();
        const response = await fetch("/api/connections/draft", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationId, name, requestId: requestId.current }) });
        const result = await response.json(); if (!response.ok) throw Error(result.error || "Could not prepare your connections.");
        onCreated(result.id);
      } catch (e) { setError(e instanceof Error ? e.message : "Please try again."); }
      finally { setBusy(false); }
    }}>
      <fieldset disabled={busy || !workspaces.length} className="setup-fields">
        <div className="form-grid"><label htmlFor={`${uid}-workspace`}>Workspace<select id={`${uid}-workspace`} required value={organizationId} onChange={e => { setOrganizationId(e.target.value); requestId.current = ""; }}>{workspaces.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
        <label htmlFor={`${uid}-name`}>Business name<input id={`${uid}-name`} required minLength={2} maxLength={100} value={name} onChange={e => setName(e.target.value)} aria-describedby={`${uid}-error ${uid}-help`} /></label></div>
        <p id={`${uid}-help`}>Only a named draft is created. No website scan, generation or publishing starts here.</p>
        <p id={`${uid}-error`} role={error ? "alert" : undefined}>{error}</p>
        <button className="button dark">{busy ? "Preparing…" : "Continue to social connections"}</button>
      </fieldset>
      {!workspaces.length && <p>A workspace owner or admin must prepare the connections.</p>}
    </form>
    <div className="destination-grid">{destinations.map(({ name, Icon, account, formats }) => <article className="destination-card" key={name}>
      <Icon size={26} aria-hidden="true" /><h3>{name}</h3><p>{account}</p><p className="muted">{formats}</p><span className="destination-state">One account per business · platform setup required</span>
    </article>)}</div>
    <p className="muted">X and YouTube are not available yet. Only publishing destinations belong here—AI providers are managed by Marketingbus.</p>
    <p>Connecting an account never approves content. Only approved, scheduled versions can be published.</p>
  </section>;
}
