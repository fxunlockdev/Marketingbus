"use client";
import { useCallback, useEffect, useId, useState } from "react";
import { BrandIntelligence } from "./brand-intelligence";
type Source = { id: string; title: string; kind: string; body: string; sourceUrl: string; status: string; retrievedAt: string | null; failureMessage?: string | null };
export function KnowledgeLibrary({ businessId, initialUrl = "" }: { businessId: string; initialUrl?: string }) {
  const uid = useId(), endpoint = `/api/businesses/${businessId}/sources`;
  const [sources, setSources] = useState<Source[]>([]), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false), [url, setUrl] = useState(initialUrl), [title, setTitle] = useState(""), [text, setText] = useState("");
  const [rights, setRights] = useState(false), [quotes, setQuotes] = useState<Record<string, string>>({}), [removing, setRemoving] = useState<string | null>(null);
  const [document, setDocument] = useState<File | null>(null);
  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(endpoint, { signal }); const data = await response.json();
    if (!response.ok) throw Error(data.error || "Could not load sources.");
    if (!signal?.aborted) setSources(data.sources);
  }, [endpoint]);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal).catch(e => { if (!controller.signal.aborted) setError(e.message); }); return () => controller.abort(); }, [load]);
  const pending = sources.some(s => ["QUEUED", "FETCHING"].includes(s.status));
  useEffect(() => { if (!pending) return; const timer = setInterval(() => { void load().catch(() => {}); }, 8000); return () => clearInterval(timer); }, [pending, load]);
  async function submit(data: Record<string, unknown>) {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
      const result = await response.json(); if (!response.ok) throw Error(result.error || "Could not update sources.");
      await load(); setRemoving(null);
      setNotice(result.evidence ? "Exact excerpt verified against the source. Review its truth, then copy it into Supporting proof in the brand form and reconfirm your profile. It has not been approved automatically." : result.cached ? "Existing source reused. No new website request queued." : "Source updated. Imported text cannot change your confirmed brand automatically.");
    } catch (e) { setError(e instanceof Error ? e.message : "Request failed."); }
    finally { setBusy(false); }
  }
  return <><BrandIntelligence key={businessId} businessId={businessId} sources={sources} /><section className="panel" aria-labelledby={`${uid}-heading`} aria-busy={busy}>
    <div className="panel-heading"><h2 id={`${uid}-heading`}>Business evidence</h2><span className="tag">Review before use</span></div>
    <p>Import a public website page, UTF-8 text/Markdown, PDF or DOCX document. Website results are reused for seven days, with three new pages per business per day. Imported text remains unapproved evidence.</p>
    <p id={`${uid}-error`} role={error ? "alert" : undefined} className="error">{error}</p><p role={notice ? "status" : undefined}>{notice}</p>
    <label className="checkbox-label"><input type="checkbox" checked={rights} onChange={e => setRights(e.target.checked)} />I have permission to import this business content.</label>
    <form className="inline-form" onSubmit={async e => {
      e.preventDefault(); if (!document) return; setBusy(true); setError(""); setNotice("");
      try {
        if (document.size > 5 * 1024 * 1024) throw Error("Use a document up to 5 MB.");
        const response = await fetch(`${endpoint}/upload`, { method: "POST", headers: { "Content-Type": "application/octet-stream", "x-document-name": document.name.replace(/[^\x20-\x7e]/g, "_"), "x-content-rights": rights ? "confirmed" : "" }, body: document });
        const result = await response.json(); if (!response.ok) throw Error(result.error);
        await load(); setNotice(result.cached ? "Matching extracted text already exists. No duplicate source was stored." : "Document text imported for review. The original file was not retained; no facts were automatically approved.");
      } catch (e) { setError(e instanceof Error ? e.message : "Document import failed."); } finally { setBusy(false); }
    }}>
      <label htmlFor={`${uid}-office`}>PDF or Word document (.pdf or .docx, up to 5 MB)</label>
      <input id={`${uid}-office`} type="file" accept=".pdf,.docx" required onChange={e => setDocument(e.target.files?.[0] ?? null)} aria-describedby={`${uid}-document-help ${uid}-error`} />
      <p id={`${uid}-document-help`} className="small muted">Selectable text only, up to 40 PDF pages and 24 KB of extracted text. Scanned PDFs need a text export. Macros, embedded images and original files are not imported.</p>
      <button className="button secondary" disabled={busy || !rights || !document}>Extract document for review</button>
    </form>
    <form className="inline-form" onSubmit={e => { e.preventDefault(); void submit({ action: "website", url, rightsConfirmed: rights }); }}>
      <label htmlFor={`${uid}-url`}>Website page</label><input id={`${uid}-url`} type="url" required maxLength={500} value={url} onChange={e => setUrl(e.target.value)} placeholder="https://your-business.example/about" aria-describedby={`${uid}-error`} />
      <button className="button secondary" disabled={busy || !rights}>Queue website import</button>
    </form>
    <form className="inline-form" onSubmit={e => { e.preventDefault(); void submit({ action: "document", title, text, rightsConfirmed: rights }); }}>
      <label htmlFor={`${uid}-file`}>Text document (.txt or .md, up to 24 KB)</label><input id={`${uid}-file`} type="file" accept=".txt,.md,text/plain,text/markdown" onChange={async e => {
        const file = e.target.files?.[0]; if (!file) return;
        if (file.size > 24000 || !/\.(txt|md)$/i.test(file.name)) { setError("Choose a .txt or .md file up to 24 KB."); return; }
        try { setText(new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer())); setTitle(file.name.slice(0, 120)); setError(""); } catch { setError("This file is not valid UTF-8 text."); }
      }} />
      <label htmlFor={`${uid}-title`}>Document title</label><input id={`${uid}-title`} required minLength={2} maxLength={120} value={title} onChange={e => setTitle(e.target.value)} />
      <label htmlFor={`${uid}-text`}>Document text</label><textarea id={`${uid}-text`} required minLength={20} maxLength={24000} value={text} onChange={e => setText(e.target.value)} aria-describedby={`${uid}-error`} />
      <button className="button secondary" disabled={busy || !rights}>Save document for review</button>
    </form>
    {!rights && <p className="small muted">Confirm your permission above to enable importing.</p>}
    {sources.map(source => <article key={source.id} className="panel">
      <h3>{source.title}</h3><p>{source.kind === "WEBSITE" ? "Website" : "Text document"} · {source.status.toLowerCase()}</p>
      {source.sourceUrl && <p className="small">Source: {source.sourceUrl}</p>}
      {source.status === "FAILED" && <div role="status"><p>{source.failureMessage || "Import failed. No automatic retry was made."}</p><p className="small">Resolve the issue before submitting the page again. Each new request counts toward your daily import allowance; your saved business details are unchanged.</p></div>}
      {source.body && <><details><summary>Read source text</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 320, overflow: "auto" }}>{source.body}</pre></details>
        <label htmlFor={`${uid}-${source.id}`}>Exact excerpt to use as evidence</label><textarea id={`${uid}-${source.id}`} maxLength={1800} value={quotes[source.id] || ""} onChange={e => setQuotes(old => ({ ...old, [source.id]: e.target.value }))} />
        <button type="button" className="button secondary" disabled={busy || (quotes[source.id]?.length || 0) < 10} onClick={() => submit({ action: "evidence", sourceId: source.id, quote: quotes[source.id] })}>Check excerpt · {source.title}</button>
      </>}
      {!["QUEUED", "FETCHING"].includes(source.status) && (removing === source.id ? <div><p>Delete this source text from the active library? This cannot be undone here. Profile facts already copied from it are not removed.</p><button type="button" className="button secondary" disabled={busy} onClick={() => submit({ action: "delete", sourceId: source.id })}>Confirm source deletion</button><button type="button" className="text-button" onClick={() => setRemoving(null)}>Cancel</button></div> : <button type="button" className="text-button" disabled={busy} onClick={() => setRemoving(source.id)}>Delete source · {source.title}</button>)}
    </article>)}
  </section></>;
}
