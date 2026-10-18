"use client";
import { useEffect, useId, useState } from "react";
type Asset = { id: string; label: string; purpose: string; width: number; height: number; status: string; approvedForGeneration: boolean; purgeAfter: string | null };
export function AssetLibrary({ businessId }: { businessId: string }) {
  const uid = useId();
  const [assets, setAssets] = useState<Asset[]>([]), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [status, setStatus] = useState("Loading private images…");
  const [file, setFile] = useState<File | null>(null), [label, setLabel] = useState("");
  const [purpose, setPurpose] = useState("product"), [rights, setRights] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState<string | null>(null);
  const endpoint = `/api/businesses/${businessId}/assets`;
  useEffect(() => {
    const controller = new AbortController();
    void fetch(endpoint, { signal: controller.signal }).then(async r => {
      const data = await r.json(); if (!r.ok) throw Error(data.error || "Could not load images.");
      setAssets(data.assets); setStatus("");
    }).catch(e => { if (!controller.signal.aborted) { setError(e.message); setStatus(""); } });
    return () => controller.abort();
  }, [endpoint]);
  async function manage(asset: Asset, action: "approve" | "archive" | "restore") {
    setBusy(true); setError(""); setStatus("");
    try {
      const response = await fetch(`${endpoint}/${asset.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action === "approve" ? { action, approved: !asset.approvedForGeneration } : { action }) });
      const data = await response.json(); if (!response.ok) throw Error(data.error || "Could not update image.");
      const refreshed = await fetch(endpoint); const list = await refreshed.json(); if (!refreshed.ok) throw Error(list.error || "Could not refresh images.");
      setAssets(list.assets); setConfirmArchive(null);
      setStatus(action === "archive" ? "Image removed from use. You can restore it for seven days; physical deletion is then queued." : action === "restore" ? "Image restored. Approve it again before generation can use it." : "Generation permission updated. No provider call was made.");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not update image."); }
    finally { setBusy(false); }
  }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!file || !rights) return;
    setBusy(true); setError(""); setStatus("Checking and uploading your image…");
    try {
      if (file.size > 5 * 1024 * 1024) throw Error("Images must be 5 MB or smaller.");
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/octet-stream", "x-asset-label": encodeURIComponent(label.trim()), "x-asset-purpose": purpose, "x-asset-rights": "confirmed" }, body: file });
      const data = await response.json(); if (!response.ok) throw Error(data.error || "Upload failed.");
      setAssets(old => [data.asset, ...old.filter(a => a.id !== data.asset.id)]);
      setStatus(data.deduplicated ? "This image is already in your private library." : "Image saved privately. It has not been sent to an AI provider.");
    } catch (e) { setError(e instanceof Error ? e.message : "Upload failed."); setStatus(""); }
    finally { setBusy(false); }
  }
  return <section className="panel asset-library" aria-labelledby={`${uid}-title`}>
    <div className="panel-heading"><h2 id={`${uid}-title`}>Your brand assets</h2><span className="tag">Private to this business</span></div>
    <p id={`${uid}-help`}>Upload logos, products and visual references. PNG, JPEG or WebP; up to 5 MB and 16 megapixels per image. Pilot allowance: 25 MB / 100 images. Approval allows future authorized generation to use an image; it does not send it to a provider now.</p>
    <form className="inline-form" onSubmit={submit} aria-busy={busy}>
      <label>Image file<input type="file" required accept="image/png,image/jpeg,image/webp" aria-describedby={`${uid}-help ${uid}-error`} onChange={e => setFile(e.target.files?.[0] || null)} /></label>
      <label>Image label<input required maxLength={100} value={label} onChange={e => setLabel(e.target.value)} placeholder="For example, primary logo" /></label>
      <label>Use this as<select value={purpose} onChange={e => setPurpose(e.target.value)}><option value="product">Product image</option><option value="logo">Logo</option><option value="reference">Visual reference</option></select></label>
      <label className="checkbox-label"><input type="checkbox" required checked={rights} onChange={e => setRights(e.target.checked)} />I have permission to upload and use this image for this business.</label>
      <p id={`${uid}-error`} role={error ? "alert" : undefined} className="error">{error}</p>
      <p role={status ? "status" : undefined}>{status}</p>
      <button className="button dark" disabled={busy}>{busy ? "Uploading…" : "Upload private image"}</button>
    </form>
    {assets.length > 0 ? <ul className="asset-grid">{assets.map(asset => <li key={asset.id}>
      {/* Authenticated same-origin images: never expose an object-store credential or public bucket URL. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {asset.status === "READY" && asset.purpose !== "generated" && <img src={`${endpoint}/${asset.id}`} alt={asset.label} width={asset.width} height={asset.height} loading="lazy" />}
      <strong>{asset.label}</strong><small>{asset.purpose} · {asset.width} × {asset.height}</small>
      {asset.status === "READY" ? <>
        {asset.purpose === "generated" ? <p>Preview and review this generated artwork in Asset studio. Removal below revokes its use immediately.</p> : <button type="button" className="button secondary" disabled={busy} aria-pressed={asset.approvedForGeneration} onClick={() => manage(asset, "approve")}>{asset.approvedForGeneration ? "Revoke generation permission" : "Approve for generation"} · {asset.label}</button>}
        {confirmArchive === asset.id ? <div>
          <p>Remove this image from use? It can be restored for seven days, then deletion is queued. Copies already exported or sent to providers are not recalled.</p>
          <button type="button" className="button secondary" disabled={busy} onClick={() => manage(asset, "archive")}>Confirm removal · {asset.label}</button>
          <button type="button" className="text-button" disabled={busy} onClick={() => setConfirmArchive(null)}>Cancel removal</button>
        </div> : <button type="button" className="text-button" disabled={busy} onClick={() => setConfirmArchive(asset.id)}>Remove image · {asset.label}</button>}
      </> : <><p>Removed from use. {asset.purgeAfter ? `Restore deadline: ${new Date(asset.purgeAfter).toLocaleDateString()}.` : "Deletion queued."}</p>
        {asset.status === "ARCHIVED" && <button type="button" className="button secondary" disabled={busy} onClick={() => manage(asset, "restore")}>Restore image · {asset.label}</button>}</>}
    </li>)}</ul> : !status && !error && <p className="muted">No images uploaded yet.</p>}
  </section>;
}
