"use client";
import { useState, useEffect } from "react";
import type { Creative } from "@/lib/production/content";
export type ProductionItemView = {
  id: string; title: string; channel: string; format: string; status: string;
  revisions: { id: string; version: number; content: Creative; status: string; feedback: string }[];
  schedule: { scheduledFor: string; timezone: string; revisionId: string } | null;
  quotes: { id: string; credits: number; status: string; expiresAt: string; job: { status: string; errorCode: string | null } | null }[];
};
type Post = (data: Record<string, unknown>) => Promise<unknown>;
function useLocalTimezone() {
  // Stable server/client first render, then opt into the browser's timezone.
  const [timezone, setTimezone] = useState("UTC");
  useEffect(() => setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone), []);
  return timezone;
}
function dateLabel(date: string, timezone: string) {
  return new Date(date).toLocaleString("en-GB", { timeZone: timezone });
}
export function ProductionCard({ item, brand, busy, post, review = false }: {
  item: ProductionItemView; brand: { name: string; color: string; designPreset: string }; busy: boolean; post: Post; review?: boolean;
}) {
  const revision = item.revisions[0];
  const [direction, setDirection] = useState(revision?.feedback || "");
  const [mode, setMode] = useState("copy");
  const [feedback, setFeedback] = useState("");
  const [remember, setRemember] = useState(false);
  const [editing, setEditing] = useState(false);
  const [headline, setHeadline] = useState(revision?.content.headline || "");
  const [caption, setCaption] = useState(revision?.content.caption || "");
  const [cta, setCta] = useState(revision?.content.cta || "");
  const [date, setDate] = useState("");
  const [quoted, setQuoted] = useState(false);
  const quote = item.quotes.find(q => q.status === "OFFERED");
  const pending = item.quotes.some(q => q.job && ["QUEUED", "RUNNING", "SUBMITTING", "NEEDS_RECONCILIATION"].includes(q.job.status));
  const blocked = busy || pending;
  const run = (action: string, extra: Record<string, unknown> = {}) => post({ action, itemId: item.id, version: revision?.version, ...extra });
  const timezone = useLocalTimezone();
  return <section className="panel production-card" aria-busy={busy}>
    <div className="panel-heading"><h2>{item.title}</h2><span className="tag">{item.channel} · {item.status.toLowerCase().replaceAll("_", " ")}</span></div>
    {pending && <p role="status" className="notice">{item.status === "NEEDS_RECONCILIATION" ? "The provider outcome needs operator review. Credits are held; no duplicate request will be sent." : "Your authorized job is queued or processing. You can leave this page; it is saved."}</p>}
    {item.status === "FAILED" && <p className="notice">The last attempt did not produce an eligible creative. Check the activity log. No automatic retry was started.</p>}
    {review && revision && <>
      <div className="creative-columns">
        <div className={`design-preview creative-preview ${brand.designPreset}`} style={{ "--brand-accent": brand.color } as React.CSSProperties}>
          <small>{brand.name}</small><strong>{revision.content.headline}</strong><span>{revision.content.cta}</span>
        </div>
        <div className="creative-copy"><span className="eyebrow">VERSION {revision.version} · COPY & LAYOUT PREVIEW</span>
          <p className="preserve-lines">{revision.content.caption}</p>
          <details><summary>Creative direction and rationale</summary><p>{revision.content.visualDirection}</p><p>{revision.content.rationale}</p></details>
          <p className="small muted">This is copy with a template preview, not an AI-generated image. Check factual claims, brand fit, legal wording and visual craft before approval.</p>
        </div>
      </div>
      {["READY", "APPROVED"].includes(revision.status) && <div className="review-controls">
        <div className="tag-row"><button className="button dark" disabled={blocked || revision.status === "APPROVED"} onClick={() => run("approve")}>{revision.status === "APPROVED" ? `Version ${revision.version} approved` : `Approve version ${revision.version}`}</button>
          <button className="button secondary" disabled={blocked} onClick={() => run("reject", { feedback })}>Reject without regenerating</button></div>
        <form onSubmit={async e => { e.preventDefault(); if (await run("revise", { feedback, remember })) { setDirection(feedback); setFeedback(""); } }}>
          <label htmlFor={`feedback-${item.id}`}>What specifically should change?</label>
          <textarea id={`feedback-${item.id}`} value={feedback} onChange={e => setFeedback(e.target.value)} required minLength={3} maxLength={1000} />
          <label className="checkbox-label"><input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />Remember this feedback as a preference for this business</label>
          <button className="button secondary" disabled={blocked}>Request changes · no charge</button>
        </form>
      </div>}
      {["READY", "APPROVED", "CHANGES_REQUESTED"].includes(revision.status) && <>
        <button className="text-button" disabled={blocked} aria-expanded={editing} aria-controls={`edit-${item.id}`} onClick={() => setEditing(!editing)}>{editing ? "Close copy editor" : "Edit copy yourself · no credits"}</button>
        {editing && <form id={`edit-${item.id}`} className="inline-form" onSubmit={async e => { e.preventDefault(); if (await run("edit", { headline, caption, cta })) setEditing(false); }}>
          <label htmlFor={`headline-${item.id}`}>Headline</label><input id={`headline-${item.id}`} required maxLength={160} value={headline} onChange={e => setHeadline(e.target.value)} />
          <label htmlFor={`caption-${item.id}`}>Caption</label><textarea id={`caption-${item.id}`} required maxLength={item.channel === "X" ? 280 : item.channel === "Instagram" ? 2200 : 3000} value={caption} onChange={e => setCaption(e.target.value)} />
          <label htmlFor={`cta-${item.id}`}>Visual call to action</label><input id={`cta-${item.id}`} maxLength={100} value={cta} onChange={e => setCta(e.target.value)} />
          <p className="small muted">Saving creates a new version and removes the previous approval and calendar reservation.</p>
          <button className="button dark" disabled={blocked}>Save new copy version</button>
        </form>}
      </>}
      {revision.status === "APPROVED" && <form className="inline-form" onSubmit={e => { e.preventDefault(); void run("schedule", { scheduledFor: new Date(date).toISOString(), timezone }); }}>
        <label htmlFor={`date-${item.id}`}>Calendar date and time ({timezone})</label><input type="datetime-local" id={`date-${item.id}`} value={date} onChange={e => setDate(e.target.value)} required />
        <p className="small muted">Internal planning only. This will not publish to a social network.</p>
        <button className="button secondary" disabled={blocked}>{item.schedule ? "Change calendar date" : "Place approved version on calendar"}</button>
      </form>}
      {item.schedule && <div className="notice"><p>Planned for {dateLabel(item.schedule.scheduledFor, timezone)} ({timezone}). Not connected for publishing.</p><button className="text-button" disabled={blocked} onClick={() => post({ action: "unschedule", itemId: item.id })}>Remove from calendar</button></div>}
    </>}
    {item.format !== "static" ? <p className="muted">Video generation and rendering are not enabled yet.</p> : (!revision || revision.status === "CHANGES_REQUESTED") && !pending && <form className="inline-form" onSubmit={async e => { e.preventDefault(); if (await post({ action: "quote", itemId: item.id, mode: revision ? mode : "initial", direction })) setQuoted(true); }}>
      {revision && <><p className="notice">Requested change: {revision.feedback}</p><label htmlFor={`mode-${item.id}`}>How much should change?</label><select id={`mode-${item.id}`} value={mode} onChange={e => { setMode(e.target.value); setQuoted(false); }}><option value="copy">Copy only · retain visual direction</option><option value="concept">Rethink the concept · creative model</option></select></>}
      <label htmlFor={`direction-${item.id}`}>{revision ? "Revision direction" : "What should this planned creative communicate?"}</label>
      <textarea id={`direction-${item.id}`} required minLength={10} maxLength={1000} value={direction} onChange={e => { setDirection(e.target.value); setQuoted(false); }} placeholder="Give this planned post a specific angle using your confirmed business facts." />
      <button className="button secondary" disabled={busy}>Get a credit quote · no generation yet</button>
      {quote && quoted && <div className="notice"><p>Up to <b>{quote.credits} credits</b> for one copy and creative-direction attempt. Unused credits are released. Quote expires {dateLabel(quote.expiresAt, timezone)} ({timezone}). Accepting does not authorize publishing.</p><button type="button" className="button dark" disabled={busy} onClick={() => post({ action: "accept", quoteId: quote.id })}>Authorize up to {quote.credits} credits</button></div>}
    </form>}
    {!review && revision && <p className="muted">Version {revision.version} is available in the Review inbox.</p>}
  </section>;
}

export function CalendarView({ items, post, busy }: { items: ProductionItemView[]; post: Post; busy: boolean }) {
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const timezone = useLocalTimezone();
  useEffect(() => { const d = new Date(); setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`); }, []);
  const scheduled = items.filter(i => {
    if (!i.schedule) return false;
    const parts = new Intl.DateTimeFormat("en", { timeZone: timezone, year: "numeric", month: "2-digit" }).formatToParts(new Date(i.schedule.scheduledFor));
    return `${parts.find(p => p.type === "year")?.value}-${parts.find(p => p.type === "month")?.value}` === month;
  }).sort((a, b) => a.schedule!.scheduledFor.localeCompare(b.schedule!.scheduledFor));
  return <section className="panel"><div className="panel-heading"><h2>Approved work, in order.</h2><div><label htmlFor="calendar-month">Month</label><input id="calendar-month" type="month" required value={month} onChange={e => setMonth(e.target.value)} /></div></div>
    <p className="notice">Times shown in {timezone}. This is an internal calendar; automatic publishing is not connected.</p>
    {scheduled.length ? <ol className="calendar-agenda">{scheduled.map(item => <li key={item.id}><time dateTime={item.schedule!.scheduledFor}>{dateLabel(item.schedule!.scheduledFor, timezone)}</time><div><h3>{item.title}</h3><p>{item.channel} · approved version {item.revisions[0]?.version}</p></div><button className="text-button" disabled={busy} onClick={() => post({ action: "unschedule", itemId: item.id })}>Remove {item.channel} reservation</button></li>)}</ol> : <p className="muted">No approved creatives scheduled this month. Add a date from the Review inbox.</p>}
  </section>;
}
