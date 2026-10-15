"use client";
import { useEffect, useState } from "react";
type Billing = {
  canManage: boolean; enabled: boolean;
  offers: { id: string; name: string; kind: string; currency: string; amountMinor: number; generalCredits: number; revisionCredits: number }[];
  wallet: { available: number; revisionAvailable: number; held: number; debt: number; revisionDebt: number } | null;
  subscriptions: { id: string; status: string; currentPeriodEnd: string }[];
  payments: { id: string; amountMinor: number; refundedMinor: number; currency: string; createdAt: string }[];
  entries: { id: string; kind: string; amount: number; createdAt: string }[];
};
const money = (amount: number, currency: string) => new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount / 100);
export function BillingPanel({ organizationId }: { organizationId: string }) {
  const [data, setData] = useState<Billing | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setData(null); setError("");
    void fetch(`/api/organizations/${organizationId}/billing`, { signal: controller.signal }).then(async response => {
      const body = await response.json(); if (!response.ok) throw Error(body.error);
      if (!controller.signal.aborted) setData(body);
    }).catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Billing could not be loaded."); });
    return () => controller.abort();
  }, [organizationId, refresh]);
  async function act(body: object) {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/organizations/${organizationId}/billing`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json(); if (!response.ok) throw Error(result.error);
      window.location.assign(result.url);
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to open billing."); }
    finally { setBusy(false); }
  }
  return <div className="production-list" aria-busy={busy || (!data && !error)}>
    {error && <p role="alert" className="form-error">{error}</p>}
    <button className="button" disabled={busy} onClick={() => setRefresh(n => n + 1)}>Refresh billing</button>
    {!data ? <p role="status">{error ? "Billing is unavailable. Try refreshing." : "Loading workspace billing…"}</p> : <>
      {!data.enabled && <p role="status">Payments are not activated. You cannot be charged here yet.</p>}
      {!data.canManage && <p>A workspace owner or administrator manages subscriptions and purchases.</p>}
      <div className="credit-grid">
        {[ ["Production credits", data.wallet?.available ?? 0], ["Revision credits", data.wallet?.revisionAvailable ?? 0], ["Reserved credits", data.wallet?.held ?? 0] ].map(([label, value]) => <section className="panel" key={label}><h2>{label}</h2><strong className="big-number">{value.toLocaleString()}</strong></section>)}
      </div>
      {!!(data.wallet?.debt || data.wallet?.revisionDebt) && <p role="alert">Production is paused by a refund adjustment: {(data.wallet?.debt ?? 0) + (data.wallet?.revisionDebt ?? 0)} credits. Released reservations and new credit allocations pay this balance first.</p>}
      <section className="panel"><h2>Room for revisions</h2><p>Revision credits are protected from initial production. Revisions use this allowance first, then production credits. Reviewing or approving work does not spend credits. Regeneration requires an accepted quote.</p><p>Balances are shared across businesses in this workspace. Unused credits currently carry forward. Refunds remove the corresponding allocation; credits are not a cash balance.</p></section>
      {data.canManage && <section className="panel"><h2>Plans and top-ups</h2>{!data.offers.length && <p>No offers are on sale yet.</p>}{data.offers.map(offer => <div className="review-explainer" key={offer.id}><div><h3>{offer.name}</h3><p>{money(offer.amountMinor, offer.currency)}{offer.kind === "SUBSCRIPTION" ? " / month" : " once"} · {offer.generalCredits} production + {offer.revisionCredits} revision credits</p></div><button className="button" disabled={busy || !data.enabled} onClick={() => void act({ action: "checkout", offerId: offer.id })}>Choose {offer.name}</button></div>)}<p>Credits appear only after payment is verified. A checkout return page is not proof of payment.</p></section>}
      {!!data.subscriptions.length && <section className="panel"><h2>Subscriptions</h2>{data.subscriptions.map(sub => <div className="review-explainer" key={sub.id}><p>{sub.status.replaceAll("_", " ")} · Current period ends {new Date(sub.currentPeriodEnd).toLocaleDateString()}</p><button className="button" disabled={busy || !data.enabled} onClick={() => void act({ action: "portal", subscriptionId: sub.id })}>Manage subscription {sub.id.slice(-6)}</button></div>)}</section>}
      {data.canManage && <section className="panel"><h2>Payment history</h2>{!data.payments.length ? <p>No verified payments yet.</p> : <ul>{data.payments.map(p => <li key={p.id}>{new Date(p.createdAt).toLocaleDateString()} · {money(p.amountMinor, p.currency)}{p.refundedMinor > 0 && ` · Refunded ${money(p.refundedMinor, p.currency)}`}</li>)}</ul>}</section>}
      <section className="panel"><h2>Recent credit activity</h2>{!data.entries.length ? <p>No credit activity yet.</p> : <ul>{data.entries.map(e => <li key={e.id}>{new Date(e.createdAt).toLocaleString()} · {e.kind.replaceAll("_", " ")} · {e.amount.toLocaleString()} credits</li>)}</ul>}</section>
    </>}
  </div>;
}
