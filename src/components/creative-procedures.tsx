"use client";
import { useEffect, useRef, useState } from "react";
type Procedure = { id: string; status: string; instruction: string; valid: boolean; candidate: null | { channel: string; task: string; examples: { id: string; feedbackQuote: string; approvedQuote: string }[] } };
type Data = { canEdit: boolean; available: { channel: string; count: number }[]; reflections: { id: string; status: string; credits: number; errorCode: string | null }[]; procedures: Procedure[] };
export function CreativeProcedures({ businessId }: { businessId: string }) {
  const [data, setData] = useState<Data | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState("");
  const [channel, setChannel] = useState("Instagram"), [reviewed, setReviewed] = useState<Record<string, boolean>>({});
  const alert = useRef<HTMLParagraphElement>(null), endpoint = `/api/businesses/${businessId}/procedures`;
  async function load() { const r = await fetch(endpoint, { cache: "no-store" }); if (!r.ok) throw Error("Could not load creative procedures."); setData(await r.json()); }
  useEffect(() => { let current = true; fetch(endpoint, { cache: "no-store" }).then(async r => { if (!r.ok) throw Error(); const body = await r.json(); if (current) setData(body); }).catch(() => { if (current) setError("Could not load creative procedures."); }); return () => { current = false; }; }, [endpoint]);
  async function act(input: Record<string, unknown>) {
    setBusy(true); setError(""); setMessage("");
    try { const r = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }); const result = await r.json(); if (!r.ok) throw Error(result.error || "Procedure update failed."); await load(); setMessage(input.action === "quote" ? "Quote ready. Review the credit ceiling before authorizing one reflection." : input.action === "accept" ? "Reflection queued. Refresh to review the result; nothing activates automatically." : "Updated. Existing creatives remain unchanged."); }
    catch (e) { setError(e instanceof Error ? e.message : "Update failed."); setTimeout(() => alert.current?.focus(), 0); } finally { setBusy(false); }
  }
  return <section className="panel" aria-labelledby="creative-procedures-heading" aria-busy={busy}>
    <h2 id="creative-procedures-heading">Creative lessons beyond simple rules</h2>
    <p>Reflect on approved corrections to propose a reusable copy or visual-direction procedure for this business. One authorized reflection uses credits; activation never happens automatically.</p>
    <p>Visual lessons use approved written direction, not image or video inspection. Review the evidence and meaning yourself. These are creative preferences—not verified facts or proof of improved results.</p>
    {error && <p role="alert" tabIndex={-1} ref={alert}>{error}</p>}{message && <p role="status">{message}</p>}
    {!data && !error && <p role="status">Loading creative procedures…</p>}
    <button className="button" disabled={busy} onClick={() => { setError(""); void load().catch(() => setError("Could not refresh creative procedures.")); }}>Refresh creative lessons</button>
    {data && <>
      <label htmlFor="reflection-destination">Destination for reflection</label>
      <select id="reflection-destination" value={channel} disabled={busy || !data.canEdit} onChange={e => setChannel(e.target.value)}>{data.available.map(a => <option key={a.channel} value={a.channel}>{a.channel} · {a.count} eligible corrections</option>)}</select>
      <p>Needs two different creatives with feedback followed by approved corrections within 90 days. Uses up to eight recent examples. Common contact details are redacted, but review feedback for sensitive information before authorizing.</p>
      <button className="button" disabled={busy || !data.canEdit || (data.available.find(a => a.channel === channel)?.count ?? 0) < 2} onClick={() => act({ action: "quote", channel })}>Get reflection credit quote</button>
      {!data.canEdit && <p>Workspace editing access is required to manage creative lessons.</p>}
      {data.reflections.map(r => <article key={r.id}><h3>Reflection · {r.status.toLowerCase().replaceAll("_", " ")}</h3><p>Authorized ceiling: {r.credits} credits. Unused credits are returned. {r.errorCode && "This reflection stopped; review its evidence or contact support for an uncertain outcome."}</p>
        {r.status === "OFFERED" && <button className="button" disabled={busy || !data.canEdit} onClick={() => act({ action: "accept", analysisId: r.id })}>Authorize reflection · up to {r.credits} credits</button>}
        {["OFFERED", "QUEUED", "RUNNING"].includes(r.status) && <button className="button" disabled={busy || !data.canEdit} onClick={() => act({ action: "cancel", analysisId: r.id })}>Cancel reflection</button>}
      </article>)}
      {data.procedures.map(p => <article key={p.id}>
        <h3>{p.candidate?.channel} · {p.candidate?.task} · {p.status === "PROCEDURE_ACTIVE" && !p.valid ? "Inactive: evidence changed" : p.status.replace("PROCEDURE_", "").toLowerCase()}</h3>
        <p style={{ whiteSpace: "pre-line" }}>{p.instruction}</p>
        <details><summary>Review supporting corrections</summary><ol>{p.candidate?.examples.map(e => <li key={e.id}><p>Feedback: “{e.feedbackQuote}”</p><p>Approved result: “{e.approvedQuote}”</p></li>)}</ol></details>
        {p.status === "PROCEDURE_PROPOSED" && <>
          <label><input type="checkbox" checked={reviewed[p.id] || false} disabled={busy || !data.canEdit || !p.valid} onChange={e => setReviewed({ ...reviewed, [p.id]: e.target.checked })} /> I checked the meaning and evidence, including conflicts with my brand rules. Replace any active procedure for this task and destination.</label>
          <button className="button" disabled={busy || !data.canEdit || !p.valid || !reviewed[p.id]} onClick={() => act({ action: "activate", proposalId: p.id, reviewedEvidence: true, replaceCurrent: true })}>Activate reviewed procedure</button>
          {!p.valid && <p>Supporting evidence changed or expired; request fresh reflection.</p>}
        </>}
        {p.status !== "PROCEDURE_RETIRED" && <button className="button" disabled={busy || !data.canEdit} onClick={() => act({ action: "retire", proposalId: p.id })}>Retire procedure</button>}
      </article>)}
      {!data.procedures.length && <p>No broader creative procedures yet. Your source skill packs and explicit preferences still apply.</p>}
    </>}
  </section>;
}
