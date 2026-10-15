"use client";
import { useCallback, useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import type { Suggestions } from "@/lib/knowledge/grounding";
type Field = Suggestions[number]["field"];
type Analysis = { id: string; status: string; credits: number; expiresAt: string; brandVersion: number; suggestions: Suggestions; rejectedFields: string[]; appliedFields: string[]; errorCode: string | null };
type View = { current: Record<Field, string>; version: number; canEdit: boolean; analyses: Analysis[] };
type Source = { id: string; title: string; status: string; body: string };
const labels: Record<Field, string> = { offering: "Offering", audience: "Audience", difference: "Differentiator", proof: "Supporting proof", tone: "Voice and tone", restrictions: "Content boundaries" };
const statuses: Record<string, string> = { OFFERED: "Awaiting authorization", QUEUED: "Queued", RUNNING: "Preparing", SUBMITTING: "Analyzing evidence", READY: "Ready for review", APPLIED: "Applied to draft", STALE: "Out of date", CANCELLED: "Cancelled", FAILED: "Stopped safely", NEEDS_RECONCILIATION: "Needs operator review" };

export function BrandIntelligence({ businessId, sources }: { businessId: string; sources: Source[] }) {
  const uid = useId(), router = useRouter(), endpoint = `/api/businesses/${businessId}/intelligence`;
  const [view, setView] = useState<View | null>(null), [selected, setSelected] = useState<string[]>([]);
  const [fields, setFields] = useState<Record<string, Field[]>>({}), [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false);
  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(endpoint, { signal }), result = await response.json();
    if (!response.ok) throw Error(result.error || "Could not load brand suggestions.");
    if (!signal?.aborted) setView(result);
  }, [endpoint]);
  const sourceSignature = sources.map(s => `${s.id}:${s.status}`).join(",");
  useEffect(() => { const controller = new AbortController(); void load(controller.signal).catch(e => { if (!controller.signal.aborted) setError(e.message); }); return () => controller.abort(); }, [load, sourceSignature]);
  const pending = view?.analyses.some(a => ["QUEUED", "RUNNING", "SUBMITTING"].includes(a.status));
  useEffect(() => { if (!pending) return; const timer = setInterval(() => { void load().catch(e => setError(e.message)); }, 6000); return () => clearInterval(timer); }, [load, pending]);
  const readySources = sources.filter(s => s.status === "PROPOSED");
  const selectedIds = selected.filter(id => readySources.some(s => s.id === id));
  const selectedBytes = readySources.filter(s => selectedIds.includes(s.id)).reduce((n, s) => n + new TextEncoder().encode(s.body).length, 0);
  const canEdit = !!view?.canEdit;
  async function act(data: Record<string, unknown>, message: string) {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
      const result = await response.json(); if (!response.ok) throw Error(result.error || "Could not update analysis.");
      await load(); setNotice(message);
      if (data.action === "apply") { setFields({}); router.refresh(); }
    } catch (e) { setError(e instanceof Error ? e.message : "Request failed."); }
    finally { setBusy(false); }
  }
  return <section className="panel intelligence-panel" aria-labelledby={`${uid}-heading`} aria-busy={busy}>
    <div className="panel-heading"><div><p className="eyebrow">BRAND INTELLIGENCE</p><h2 id={`${uid}-heading`}>Evidence into direction.</h2></div><span className="tag">You stay in control</span></div>
    <p>Find useful facts and a writing voice in your business documents. Compare every suggestion with its source, then choose what belongs in your brand.</p>
    <p className="small muted">Facts stay as exact source excerpts. Tone is an interpretation. Neither proves that a source is true; verify claims before confirming your brand.</p>
    <p id={`${uid}-error`} role={error ? "alert" : undefined} className="error">{error}</p><p role={notice ? "status" : undefined}>{notice}</p>
    {!view && !error && <p role="status">Loading review queue…</p>}
    {!canEdit && view && <p>Read-only access. A workspace editor can authorize analysis and apply suggestions.</p>}
    <fieldset disabled={!canEdit || busy} aria-describedby={`${uid}-source-help ${uid}-error`}>
      <legend>1. Choose your evidence</legend>
      <p id={`${uid}-source-help`} className="small muted">Select one to three imported sources, up to 24 KB combined. Getting a quote does not spend credits.</p>
      {!readySources.length && <p>Import a business document or website page in Business evidence below to begin.</p>}
      <div className="intelligence-sources">{readySources.map(s => <label className="checkbox-label" key={s.id}><input type="checkbox" checked={selectedIds.includes(s.id)} disabled={!selectedIds.includes(s.id) && selectedIds.length >= 3} onChange={e => setSelected(old => e.target.checked ? [...old, s.id] : old.filter(id => id !== s.id))} />{s.title}</label>)}</div>
      <p className="small">{selectedIds.length} selected · {(selectedBytes / 1000).toFixed(1)} / 24 KB</p>
      <button className="button secondary" type="button" disabled={!selectedIds.length || selectedBytes > 24000 || !!pending} onClick={() => act({ action: "quote", sourceIds: selectedIds }, "Quote prepared. Review the credit ceiling before authorizing analysis.")}>Get analysis quote</button>
      {(selectedBytes > 24000 || pending) && <p className="small">{pending ? "Your current analysis is still processing." : "Choose fewer sources or import a shorter excerpt."}</p>}
    </fieldset>
    <div className="panel-heading"><h3>2. Review proposed changes</h3><button className="text-button" type="button" disabled={busy} onClick={() => { setError(""); void load().catch(e => setError(e.message)); }}>Refresh suggestions</button></div>
    {view && !view.analyses.length && <p>No analysis yet. Your current brand profile stays unchanged until you apply a suggestion.</p>}
    {view?.analyses.map((analysis, index) => {
      const isCurrent = analysis.status === "READY" && analysis.brandVersion === view.version;
      const picked = (fields[analysis.id] || []).filter(f => !analysis.rejectedFields.includes(f));
      return <article key={analysis.id} className="intelligence-review" aria-label={`Analysis ${view.analyses.length - index}`}>
        <div className="panel-heading"><h4>Brand review · version {analysis.brandVersion}</h4><span className="tag">{statuses[analysis.status] || analysis.status}</span></div>
        {analysis.status === "OFFERED" && <div><p>Reserve up to <strong>{analysis.credits} credits</strong>. Unused credits are returned after measured usage. An empty result or one that fails validation uses no customer credits; rejecting a valid suggestion does not refund its analysis cost.</p><p className="small">Quote expires {new Date(analysis.expiresAt).toLocaleString()}. Authorizing sends the selected source text to the configured AI service. It does not confirm facts or publish content.</p><button className="button" type="button" disabled={busy || !canEdit} onClick={() => act({ action: "accept", analysisId: analysis.id }, "Analysis authorized. Suggestions will appear here for review.")}>Authorize · up to {analysis.credits} credits</button></div>}
        {["OFFERED", "QUEUED", "RUNNING"].includes(analysis.status) && <button className="text-button" type="button" disabled={busy || !canEdit} onClick={() => act({ action: "cancel", analysisId: analysis.id }, "Cancelled before submission. Held credits were released.")}>Cancel analysis</button>}
        {["QUEUED", "RUNNING", "SUBMITTING"].includes(analysis.status) && <p role="status">{analysis.status === "SUBMITTING" ? "Evidence is being analyzed. Submission has started; do not submit another request." : "Waiting for the production worker. No brand fields will change automatically."}</p>}
        {analysis.status === "NEEDS_RECONCILIATION" && <p role="status">The provider outcome is uncertain. Credits remain held for operator review; no duplicate request will be sent.</p>}
        {analysis.status === "FAILED" && <p>No eligible suggestions were delivered. Your credit hold was released. Review your sources before requesting a new quote.</p>}
        {analysis.status === "STALE" && <p>The brand or its evidence changed. These suggestions can no longer be applied.</p>}
        {analysis.status === "APPLIED" && <p>Selected changes were saved to the draft. Review the brand profile and confirm it before creating a new content plan.</p>}
        {analysis.status === "READY" && !analysis.suggestions.length && <p>No supported improvements were found. No customer credits were consumed.</p>}
        {analysis.suggestions.map(s => <div className="intelligence-suggestion" key={s.field}>
          <div className="panel-heading"><h5>{labels[s.field]}</h5><span className="tag">{analysis.appliedFields.includes(s.field) ? "Applied" : analysis.rejectedFields.includes(s.field) ? "Rejected" : s.kind === "INFERRED_TONE" ? "Inferred preference" : "Exact source excerpt"}</span></div>
          <div className="intelligence-compare"><div><span className="small muted">Current profile</span><p>{view.current[s.field] || "Not provided"}</p></div><div><span className="small muted">Proposed replacement</span><p>{s.value}</p></div></div>
          <p className="small">{s.reason}</p>
          <details><summary>Inspect supporting evidence</summary>{s.citations.map((c, i) => <div key={i}><p className="small"><strong>{sources.find(source => source.id === c.sourceId)?.title || "Source removed"}</strong></p><blockquote>{c.excerpt}</blockquote><p className="small muted" style={{ overflowWrap: "anywhere" }}>Source fingerprint: {c.sha256}</p></div>)}</details>
          {isCurrent && !analysis.rejectedFields.includes(s.field) && <div className="intelligence-actions"><label className="checkbox-label"><input type="checkbox" disabled={busy || !canEdit} checked={picked.includes(s.field)} onChange={e => setFields(old => ({ ...old, [analysis.id]: e.target.checked ? [...picked, s.field] : picked.filter(f => f !== s.field) }))} />Apply {labels[s.field].toLowerCase()}</label><button type="button" className="text-button" disabled={busy || !canEdit} onClick={() => act({ action: "reject", analysisId: analysis.id, field: s.field }, `${labels[s.field]} suggestion rejected. No regeneration or charge.`)}>Reject {labels[s.field].toLowerCase()}</button></div>}
        </div>)}
        {isCurrent && analysis.suggestions.length > 0 && <div className="intelligence-apply"><p className="small">Applying replaces only selected fields, creates a new draft version and clears existing confirmation and schedules. Unselected suggestions become out of date. Review all desired fields together.</p><button className="button" type="button" disabled={busy || !canEdit || !picked.length} onClick={() => act({ action: "apply", analysisId: analysis.id, fields: picked, version: view.version }, "Selected suggestions applied to your draft. Review and confirm the brand profile separately.")}>Apply selected to draft ({picked.length})</button></div>}
      </article>;
    })}
  </section>;
}
