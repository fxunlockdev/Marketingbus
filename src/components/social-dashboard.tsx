"use client";
import { useEffect, useRef, useState } from "react";
type Dashboard = {
  enabledProviders: string[];
  imageProviders?: string[];
  mediaChoices?: { id: string; itemId: string; revisionVersion: number; placement: string; expiresAt: string; bytes: number }[];
  enabledMetricProviders: string[];
  canManageMetrics: boolean;
  window: string;
  connections: {
    id: string;
    label: string;
    provider: string;
    status: string;
    expiresAt: string | null;
  }[];
  publications: {
    id: string;
    status: string;
    scheduledFor: string;
    publishedAt: string | null;
    permalink: string | null;
    externalPostId: string | null;
    errorCode: string | null;
    includesImage?: boolean;
    imageUploadAcknowledged?: boolean;
    reconciliationAttempts: number;
    nextReconciliationAt: string | null;
    metricsFailures: number;
    metricsInvalidatedAt: string | null;
    metricsRequestedAt: string | null;
    nextMetricsAt: string | null;
    connection: { label: string; provider: string };
    revision: { version: number; item: { title: string } };
  }[];
  summary: {
    key: string;
    provider: string;
    connectionId: string;
    posts: number;
    latestObservation: string | null;
    note: string;
    metrics: Record<string, { value: number | null; coveredPosts: number }>;
  }[];
  proposals: {
    id: string;
    hypothesis: string;
    status: string;
    evidence: unknown;
  }[];
};
export function SocialDashboard({
  businessId,
  items,
}: {
  businessId: string;
  items: {
    id: string;
    title: string;
    channel: string;
    revisions: { version: number; status: string }[];
  }[];
}) {
  const [data, setData] = useState<Dashboard | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [refresh, setRefresh] = useState(0),
    [message, setMessage] = useState("");
  const [itemId, setItem] = useState(""),
    [mediaExportId, setMediaExportId] = useState(""),
    [connectionId, setConnection] = useState(""),
    [when, setWhen] = useState("");
  const resultRef = useRef<HTMLParagraphElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  useEffect(() => { if (message.startsWith("Metric checks queued.")) resultRef.current?.focus(); }, [message]);
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError("");
    void fetch(`/api/businesses/${businessId}/social`, {
      signal: controller.signal,
    })
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw Error(body.error);
        if (!controller.signal.aborted) setData(body);
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(
            e instanceof Error ? e.message : "Unable to load publishing."
          );
      });
    return () => controller.abort();
  }, [businessId, refresh]);
  async function act(path: string, input: unknown) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`/api/businesses/${businessId}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const result = await response.json();
      if (!response.ok) throw Error(result.error);
      setRefresh((n) => n + 1);
      setMessage(path === "social/metrics" ? "Metric checks queued. No post was sent and no credits changed." : "Saved to this business.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to save.");
    } finally {
      setBusy(false);
    }
  }
  const approved = items.filter((i) => i.revisions[0]?.status === "APPROVED"),
    selected = approved.find((i) => i.id === itemId);
  return (
    <div className="production-list" aria-busy={busy}>
      <p role="alert" className="form-error" ref={errorRef} tabIndex={-1}>
        {error}
      </p>
      <p role="status" tabIndex={-1} ref={resultRef}>{message}</p>
      {!data ? (
        <p role="status">
          {error
            ? "Publishing could not be loaded."
            : "Loading publishing and performance…"}
        </p>
      ) : (
        <>
          <section className="panel">
            <h2>Social accounts</h2>
            <p>
              Connections are scoped to this business. Tokens never appear in
              this screen. Use Connections to connect or disconnect an account.
            </p>
            {!data.enabledProviders.length && (
              <p className="muted">
                Live social integrations are not activated. No posts will be
                sent and no sample analytics are shown.
              </p>
            )}
            {!data.connections.length && <p>No accounts connected.</p>}
            {data.connections.map((c) => (
              <div className="review-explainer" key={c.id}>
                <div>
                  <h3>{c.label}</h3>
                  <p>
                    {c.provider} · {c.status.replaceAll("_", " ")}
                  </p>
                  {c.expiresAt && (
                    <small>
                      Access expires {new Date(c.expiresAt).toLocaleString()}
                    </small>
                  )}
                </div>
              </div>
            ))}
          </section>
          <section className="panel">
            <h2>Schedule an approved version</h2>
            <p>
              Publishing is separate from an internal calendar reservation.
              Changing approved work cancels its queued publication.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (selected && when)
                  void act("social", {
                    action: "schedule",
                    itemId,
                    version: selected.revisions[0].version,
                    connectionId,
                    scheduledFor: new Date(when).toISOString(),
                    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                    ...(mediaExportId ? { mediaExportId } : {}),
                  });
              }}
            >
              <label htmlFor="social-creative">Approved creative</label>
              <select
                id="social-creative"
                required
                value={itemId}
                onChange={(e) => {
                  setItem(e.target.value);
                  setConnection("");
                  setMediaExportId("");
                }}
              >
                <option value="">Choose a creative</option>
                {approved.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.title} · {i.channel} · version {i.revisions[0].version}
                  </option>
                ))}
              </select>
              {selected && <div>
                <label htmlFor="social-image">Approved image export</label>
                <select id="social-image" aria-describedby="social-image-help" required={selected.channel === "Instagram"} value={mediaExportId} disabled={!data.imageProviders?.includes(selected.channel)} onChange={e => setMediaExportId(e.target.value)}>
                  <option value="">{selected.channel === "Instagram" ? "Choose an approved image (required)" : "Text only"}</option>
                  {(data.mediaChoices ?? []).filter(image => image.itemId === selected.id && image.revisionVersion === selected.revisions[0].version && (selected.channel !== "Instagram" || ["square", "portrait"].includes(image.placement))).map(image => <option key={image.id} value={image.id}>{image.placement} · {image.id.slice(-6)} · expires {new Date(image.expiresAt).toLocaleDateString()}</option>)}
                </select>
                <p id="social-image-help">{data.imageProviders?.includes(selected.channel) ? "Only saved exports of this exact approved version are listed. The approved headline is used as image alt text. Schedule before the export expires." : "Image publishing is not activated for this destination. No image will be sent."}{selected.channel === "Instagram" ? " Instagram requires a square or portrait image and a caption of up to 2,200 characters. A JPEG copy is delivered to Meta through a temporary, download-limited link; your storage bucket stays private." : " The image is uploaded privately to the destination; your storage bucket stays private."}{selected.channel === "Facebook" && " Facebook image exports must be 4 MB or smaller."} Changing or removing the approved artwork cancels queued publication; published copies must be managed on the network.</p>
                {mediaExportId && <a href={`/api/businesses/${businessId}/exports/${encodeURIComponent(mediaExportId)}`} target="_blank" rel="noopener noreferrer">Download selected approved image</a>}
              </div>}
              <label htmlFor="social-account">Destination account</label>
              <select
                id="social-account"
                required
                value={connectionId}
                onChange={(e) => setConnection(e.target.value)}
              >
                <option value="">Choose a connected account</option>
                {data.connections
                  .filter(
                    (c) =>
                      c.status === "CONNECTED" &&
                      c.provider === selected?.channel &&
                      data.enabledProviders.includes(c.provider)
                  )
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
              </select>
              <label htmlFor="social-date">
                Publish at (your local timezone)
              </label>
              <input
                id="social-date"
                type="datetime-local"
                required
                value={when}
                onChange={(e) => setWhen(e.target.value)}
              />
              <button
                className="button dark"
                disabled={busy || !connectionId || !selected}
              >
                Schedule social publication
              </button>
            </form>
          </section>
          <section className="panel">
            <h2>Publication history</h2>
            {!data.publications.length && <p>No social publications yet.</p>}
            {data.publications.map((p) => (
              <article key={p.id} className="memory-card">
                <h3>{p.revision.item.title}</h3>
                <p>
                  {p.connection.provider} · {p.connection.label} · version{" "}
                  {p.revision.version}
                </p>
                <p>
                  {p.status.replaceAll("_", " ")} ·{" "}
                  {new Date(p.scheduledFor).toLocaleString()}
                </p>
                {p.errorCode && <p>{p.errorCode.replaceAll("_", " ")}</p>}
                {p.includesImage && <p>Includes an approved image. {p.imageUploadAcknowledged ? "Image upload acknowledged by the destination; publication is confirmed only when a provider post ID is shown below." : "Image upload has not been acknowledged. No completed post is implied."}</p>}
                {p.status === "NEEDS_RECONCILIATION" && <div>
                  <p>Publication is unconfirmed. This post will not be sent again automatically.</p>
                  <p>Lookup checks: {p.reconciliationAttempts}. {p.nextReconciliationAt
                    ? `Next eligible lookup: ${new Date(p.nextReconciliationAt).toLocaleString()}.`
                    : p.reconciliationAttempts > 0 ? "Automatic lookup stopped. Operator review is required."
                    : "Lookup is waiting for an available publishing integration."}</p>
                </div>}
                {p.externalPostId && (
                  <p>Provider post ID: {p.externalPostId}</p>
                )}
                {p.permalink && (
                  <a
                    href={p.permalink}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    View published post
                  </a>
                )}
                {p.metricsInvalidatedAt && <p>Metrics excluded: the published creative no longer matches its approved version. Historical records and the published-post receipt are retained, but are not used in reporting or future learning. This post will not be sent again.</p>}
                {!p.metricsInvalidatedAt && p.metricsFailures > 0 && (
                  <p>
                    {p.nextMetricsAt ? `Metrics refresh is delayed. Next eligible check: ${new Date(p.nextMetricsAt).toLocaleString()}.` : "Automatic metric checks have stopped. Review account access before resuming."} Previously observed data is retained.
                  </p>
                )}
                {p.status === "PUBLISHED" && !p.metricsInvalidatedAt && !p.nextMetricsAt && p.metricsFailures > 0 && <div>
                  <p>Recovery only reads existing post metrics; it does not repost content, spend creative credits or change approvals. Limited to posts from the last 30 days, once per post per hour and six requests per business per UTC day.</p>
                  {!data.canManageMetrics ? <p>A workspace owner or admin can resume checks.</p> : !data.enabledMetricProviders.includes(p.connection.provider) ? <p>Verified post metrics are not enabled for this destination yet.</p> : <button className="button" disabled={busy} onClick={() => {
                    if (window.confirm("Resume read-only metric checks for this existing post? No content will be posted and no credits will be spent.")) void act("social/metrics", { publicationId: p.id, expectedRequestedAt: p.metricsRequestedAt });
                  }}>Resume metric checks</button>}
                </div>}
                {p.status === "SCHEDULED" && (
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() =>
                      act("social", { action: "cancel", publicationId: p.id })
                    }
                  >
                    Cancel publication
                  </button>
                )}
              </article>
            ))}
          </section>
          <section className="panel">
            <h2>Performance evidence</h2>
            <p>{data.window}</p>
            {!data.summary.length && (
              <p>
                No verified performance data yet. Connect accounts and publish
                before drawing conclusions.
              </p>
            )}
            {data.summary.map((group) => (
              <article key={group.key}>
                <h3>
                  {data.connections.find((c) => c.id === group.connectionId)
                    ?.label ?? group.provider}
                </h3>
                <p>
                  {group.posts} posts ·{" "}
                  {group.latestObservation
                    ? `Last observed ${new Date(
                        group.latestObservation
                      ).toLocaleString()}`
                    : "Not yet observed"}
                </p>
                <table>
                  <caption>Available lifetime metrics and coverage</caption>
                  <thead>
                    <tr>
                      <th scope="col">Metric</th>
                      <th scope="col">Observed total</th>
                      <th scope="col">Posts covered</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(group.metrics).map(([metric, reading]) => (
                      <tr key={metric}>
                        <th scope="row">{metric}</th>
                        <td>
                          {reading.value === null
                            ? "Unavailable"
                            : reading.value.toLocaleString()}
                        </td>
                        <td>
                          {reading.coveredPosts} / {group.posts}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="muted">{group.note}</p>
              </article>
            ))}
          </section>
          <section className="panel">
            <h2>Evidence-based experiments</h2>
            <p>
              Compare current-brand posts on the same account using measurements
              taken 72–96 hours after publication, not lifetime totals. Each format
              needs at least five posts and 1,000 impressions. Approval rechecks
              the saved evidence within seven days and saves a reversible experiment,
              not a proven fact. Experiments stop informing new work after 30 days
              or when their evidence becomes invalid.
            </p>
            <button
              className="button"
              disabled={busy}
              onClick={() => act("learning", { action: "evaluate" })}
            >
              Evaluate available evidence
            </button>
            {data.proposals.map((p) => (
              <article key={p.id} className="memory-card">
                <p>{p.hypothesis}</p>
                <span className="tag">{p.status}</span>
                <details>
                  <summary>View supporting observations</summary>
                  <pre
                    style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
                  >
                    {JSON.stringify(p.evidence, null, 2)}
                  </pre>
                </details>
                {p.status === "PROPOSED" && (
                  <>
                    <button
                      className="button"
                      disabled={busy}
                      onClick={() =>
                        act("learning", { action: "promote", proposalId: p.id })
                      }
                    >
                      Approve as an experiment
                    </button>
                    <button
                      className="button"
                      disabled={busy}
                      onClick={() =>
                        act("learning", { action: "reject", proposalId: p.id })
                      }
                    >
                      Reject experiment
                    </button>
                  </>
                )}
                {p.status === "PROMOTED" && (
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() =>
                      act("learning", { action: "revert", proposalId: p.id })
                    }
                  >
                    Revert experiment
                  </button>
                )}
              </article>
            ))}
          </section>
        </>
      )}
    </div>
  );
}
