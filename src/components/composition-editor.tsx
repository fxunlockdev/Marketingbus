"use client";
import { useEffect, useState } from "react";
import { SavedExports } from "./saved-exports";
import { ImageProduction } from "./image-production";
import { STATIC_RENDERER_VERSION } from "@/lib/composition/version";
import {
  canvasDocument,
  placements,
  type CanvasDocument,
  type Placement,
} from "@/lib/composition/document";
type Composition = {
  id: string;
  itemId: string;
  revisionId: string;
  version: number;
  status: string;
  approvedRendererVersion: string | null;
  document: CanvasDocument;
};
export function CompositionEditor({
  businessId,
  items,
  initialItemId,
}: {
  businessId: string;
  initialItemId?: string;
  items: {
    id: string;
    title: string;
    format: string;
    revisions: { id: string; version: number; status: string }[];
  }[];
}) {
  const [generationRefresh, setGenerationRefresh] = useState(0);
  const [compositions, setCompositions] = useState<Composition[]>([]),
    [itemId, setItemId] = useState(items.some(i => i.id === initialItemId && i.format === "static" && ["READY", "APPROVED"].includes(i.revisions[0]?.status)) ? initialItemId! : ""),
    [document, setDocument] = useState<CanvasDocument | null>(null),
    [placement, setPlacement] = useState<Placement>("square"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [preview, setPreview] = useState("");
  const selected = items.find((i) => i.id === itemId),
    composition = compositions.find((c) => c.itemId === itemId);
  useEffect(() => {
    const abort = new AbortController();
    void fetch(`/api/businesses/${businessId}/compositions`, {
      signal: abort.signal,
    })
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw Error(data.error);
        if (!abort.signal.aborted) setCompositions(data.compositions);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(String(e.message));
      });
    return () => abort.abort();
  }, [businessId, generationRefresh]);
  useEffect(() => {
    setDocument(composition?.document ?? null);
    setPreview("");
  }, [composition]);
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview]
  );
  async function act(input: unknown) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const r = await fetch(`/api/businesses/${businessId}/compositions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const data = await r.json();
      if (!r.ok) throw Error(data.error);
      setCompositions((old) => [
        data.composition,
        ...old.filter((c) => c.itemId !== data.composition.itemId),
      ]);
      setMessage(
        "Composition saved. Copy approval and visual approval are separate."
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to save.");
    } finally {
      setBusy(false);
    }
  }
  async function download(format: "png" | "svg" | "json", isPreview = false) {
    if (!composition) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        `/api/businesses/${businessId}/compositions?export=${encodeURIComponent(
          composition.id
        )}&placement=${placement}&format=${format}&preview=${isPreview}`
      );
      if (!response.ok) throw Error((await response.json()).error);
      const url = URL.createObjectURL(await response.blob());
      if (isPreview) setPreview(url);
      else {
        const link = window.document.createElement("a");
        link.href = url;
        link.download = `creative-${placement}.${format}`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to export.");
    } finally {
      setBusy(false);
    }
  }
  function updateLayer(index: number, field: string, value: string | number) {
    if (document)
      setDocument({
        ...document,
        layers: document.layers.map((layer, n) =>
          n === index ? { ...layer, [field]: value } : layer
        ),
      });
    setPreview("");
  }
  return (
    <div className="production-list" aria-busy={busy}>
      <ImageProduction businessId={businessId} items={items} initialItemId={initialItemId} onChange={() => setGenerationRefresh(n => n + 1)} />
      <p role="alert" className="form-error">
        {error}
      </p>
      <p role="status">{message}</p>
      <section className="panel">
        <h2>Compose with your approved assets</h2>
        <p>
          Logos and product photos are placed directly without generative
          redrawing. This is a template compositor, not Gemini image generation.
          Text comes from the exact copy revision.
        </p>
        <label htmlFor="composition-item">Creative</label>
        <select
          id="composition-item"
          value={itemId}
          onChange={(e) => setItemId(e.target.value)}
        >
          <option value="">Choose reviewed static copy</option>
          {items
            .filter(
              (i) =>
                i.format === "static" &&
                ["READY", "APPROVED"].includes(i.revisions[0]?.status)
            )
            .map((i) => (
              <option key={i.id} value={i.id}>
                {i.title} · copy v{i.revisions[0].version}
              </option>
            ))}
        </select>
        <button
          className="button"
          disabled={busy || !selected}
          onClick={() =>
            selected &&
            act({
              action: "create",
              itemId,
              revisionVersion: selected.revisions[0].version,
            })
          }
        >
          Use approved brand assets
        </button>
      </section>
      {document && composition && (
        <>
          <section className="panel">
            <h2>Editable layout · version {composition.version}</h2>
            <p>
              {composition.status}. Saving a change creates a new version and
              requires fresh visual approval.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const result = canvasDocument.safeParse(document);
                if (!result.success) {
                  setError(result.error.issues[0].message);
                  return;
                }
                void act({
                  action: "edit",
                  itemId,
                  version: composition.version,
                  document: result.data,
                });
              }}
            >
              <label htmlFor="canvas-background">Background colour</label>
              <input
                id="canvas-background"
                type="color"
                value={document.background}
                onChange={(e) => {
                  setDocument({ ...document, background: e.target.value });
                  setPreview("");
                }}
              />
              {document.layers.map((layer, index) => (
                <fieldset key={index}>
                  <legend>
                    {layer.kind === "text" ? layer.field : "Approved image"}{" "}
                    layer {index + 1}
                  </legend>
                  <div className="composition-controls">
                    {(["x", "y", "width", "height"] as const).map((field) => (
                      <label key={field}>
                        {field} (%)
                        <input
                          type="number"
                          min={field === "width" || field === "height" ? 5 : 0}
                          max="100"
                          step="1"
                          value={Math.round(layer[field] * 100)}
                          onChange={(e) =>
                            updateLayer(
                              index,
                              field,
                              Number(e.target.value) / 100
                            )
                          }
                          required
                        />
                      </label>
                    ))}
                    {layer.kind === "text" && (
                      <>
                        <label>
                          Text size (% of width)
                          <input
                            type="number"
                            min="1.5"
                            max="12"
                            step="0.5"
                            value={Math.round(layer.fontSize * 1000) / 10}
                            onChange={(e) =>
                              updateLayer(
                                index,
                                "fontSize",
                                Number(e.target.value) / 100
                              )
                            }
                            required
                          />
                        </label>
                        <label>
                          Text colour
                          <input
                            type="color"
                            value={layer.color}
                            onChange={(e) =>
                              updateLayer(index, "color", e.target.value)
                            }
                          />
                        </label>
                      </>
                    )}
                  </div>
                </fieldset>
              ))}
              <button className="button dark" disabled={busy}>
                Save layout version · no credits
              </button>
            </form>
          </section>
          <section className="panel">
            <h2>Preview and export</h2>
            <p>
              Preview renders the saved layout with measured Figtree typography.
              Oversized text and unsupported characters are rejected instead of
              silently changed. Review every placement before using it.
            </p>
            <p className="muted">Latin and supported Latin-extended text are available. Emoji and other writing systems need additional fonts. SVG downloads contain fixed outlines; edit text through the copy and JSON layout, not the exported outlines.</p>
            {composition.status === "APPROVED" && composition.approvedRendererVersion !== STATIC_RENDERER_VERSION && <p role="status">Typography has changed since this layout was approved. Render a new preview and approve it again before downloading.</p>}
            <label htmlFor="composition-placement">Canvas size</label>
            <select
              id="composition-placement"
              value={placement}
              onChange={(e) => {
                setPlacement(e.target.value as Placement);
                setPreview("");
              }}
            >
              {Object.entries(placements).map(([key, size]) => (
                <option key={key} value={key}>
                  {key} · {size.join(" × ")}
                </option>
              ))}
            </select>
            <div className="tag-row">
              <button
                className="button"
                disabled={busy}
                onClick={() => download("png", true)}
              >
                Render saved preview
              </button>
              <button
                className="button"
                disabled={
                  busy ||
                  selected?.revisions[0]?.status !== "APPROVED" ||
                  (composition.status === "APPROVED" && composition.approvedRendererVersion === STATIC_RENDERER_VERSION)
                }
                onClick={() =>
                  act({
                    action: "approve",
                    itemId,
                    version: composition.version,
                    rendererVersion: STATIC_RENDERER_VERSION,
                  })
                }
              >
                Approve saved composition
              </button>
            </div>
            {selected?.revisions[0]?.status !== "APPROVED" && (
              <p>
                Approve the copy in the Review inbox before approving this
                composition.
              </p>
            )}
            {preview && (
              <img
                src={preview}
                alt="Saved composition preview for visual review"
                style={{
                  maxWidth: "100%",
                  maxHeight: 650,
                  objectFit: "contain",
                }}
              />
            )}
            <div className="tag-row">
              {(["png", "svg", "json"] as const).map((format) => (
                <button
                  key={format}
                  className="button"
                  disabled={busy || composition.status !== "APPROVED" || composition.approvedRendererVersion !== STATIC_RENDERER_VERSION}
                  onClick={() => download(format)}
                >
                  Download {format.toUpperCase()}
                </button>
              ))}
            </div>
          </section>
          <SavedExports businessId={businessId} compositionId={composition.id} placement={placement} approved={composition.status === "APPROVED" && composition.approvedRendererVersion === STATIC_RENDERER_VERSION && selected?.revisions[0]?.status === "APPROVED"} />
        </>
      )}
    </div>
  );
}
