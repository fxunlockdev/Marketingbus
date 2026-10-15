"use client";
import { useCallback, useEffect, useId, useState } from "react";
import type { Placement } from "@/lib/composition/document";
type Export = { id: string; compositionId: string; placement: string; status: string; bytes: number; sha256: string; purgeAfter: string };
export function SavedExports({ businessId, compositionId, placement, approved }: { businessId: string; compositionId: string; placement: Placement; approved: boolean }) {
  const uid = useId(), endpoint = `/api/businesses/${businessId}/exports`;
  const [rows, setRows] = useState<Export[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState(""), [removing, setRemoving] = useState("");
  const load = useCallback(async (signal?: AbortSignal) => { const response = await fetch(endpoint, { signal }), result = await response.json(); if (!response.ok) throw Error(result.error); if (!signal?.aborted) setRows(result.exports); }, [endpoint]);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal).catch(e => { if (!controller.signal.aborted) setError(e.message); }); return () => controller.abort(); }, [load, compositionId]);
  const pending = rows.some(r => r.status === "STORING");
  useEffect(() => { if (!pending) return; const timer = setInterval(() => { void load().catch(e => setError(e.message)); }, 8000); return () => clearInterval(timer); }, [pending, load]);
  async function act(data: Record<string, unknown>) {
    setBusy(true); setError(""); setNotice("");
    try { const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }), result = await response.json(); if (!response.ok) throw Error(result.error); await load(); setRemoving(""); setNotice(data.action === "archive" ? "Export access removed. Storage cleanup is scheduled after seven days; existing downloaded copies cannot be recalled." : data.action === "reconcile" ? "Stored output verified. No duplicate upload was made." : result.reused ? "Existing approved export reused without rendering or uploading again." : "Approved export saved and verified. No AI credits used and nothing published."); }
    catch (e) { setError(e instanceof Error ? e.message : "Export failed."); void load().catch(() => {}); } finally { setBusy(false); }
  }
  async function download(row: Export) {
    setBusy(true); setError("");
    try { const response = await fetch(`${endpoint}/${row.id}`); if (!response.ok) throw Error((await response.json()).error); const url = URL.createObjectURL(await response.blob()), link = document.createElement("a"); link.href = url; link.download = `approved-${row.placement}.png`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
    catch (e) { setError(e instanceof Error ? e.message : "Download failed."); } finally { setBusy(false); }
  }
  return <section className="panel" aria-labelledby={`${uid}-title`} aria-busy={busy}>
    <h2 id={`${uid}-title`}>Saved publishing exports</h2>
    <p>Save the exact approved layout as a private, versioned PNG. Every download rechecks the brand, copy, asset permissions and file fingerprint. This does not publish a post.</p>
    <p className="small muted">Up to 5 MB per export, 50 MB or 50 exports per business. Saved files expire after 30 days. A changed layout requires a new approval and export.</p>
    <p role={error ? "alert" : undefined} className="error">{error}</p><p role={notice ? "status" : undefined}>{notice}</p>
    <button className="button" type="button" disabled={busy || !approved} onClick={() => act({ action: "save", compositionId, placement })}>Save approved {placement} export</button>
    {!approved && <p className="small">Approve the saved copy and composition before saving a publishing export.</p>}
    {!rows.length && <p>No saved exports yet. The regular preview and download controls remain available above.</p>}
    {rows.map(row => <article key={row.id} className="export-row"><h3>{row.placement} · {row.compositionId === compositionId ? "selected layout" : "another layout version"}</h3><p>{row.status.toLowerCase()} · {(row.bytes / 1024).toFixed(0)} KB · cleanup after {new Date(row.purgeAfter).toLocaleDateString()}</p>
      {row.status === "READY" && <button className="button secondary" type="button" disabled={busy} onClick={() => download(row)}>Download saved {row.placement}</button>}
      {["FAILED", "STORING"].includes(row.status) && (row.sha256 ? <><p className="small">Storage is not verified. Check the existing object without submitting another upload.</p><button className="button secondary" type="button" disabled={busy} onClick={() => act({ action: "reconcile", exportId: row.id })}>Check storage outcome</button></> : <p className="small">No storage write has started. Once any active operation finishes, use Save approved export to retry this layout and canvas size.</p>)}
      {!["ARCHIVED", "DELETING"].includes(row.status) && (removing === row.id ? <div><p>Remove access to this saved export? It will be physically removed after seven days. Save a new layout version if you need another export.</p><button className="button secondary" type="button" disabled={busy} onClick={() => act({ action: "archive", exportId: row.id })}>Confirm export removal</button><button className="text-button" type="button" onClick={() => setRemoving("")}>Keep export</button></div> : <button className="text-button" type="button" disabled={busy} onClick={() => setRemoving(row.id)}>Remove saved {row.placement}</button>)}
    </article>)}
  </section>;
}
