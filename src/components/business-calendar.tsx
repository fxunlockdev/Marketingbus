"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { calendarWindow, localDay, localMinute, parseLocalMinute } from "@/lib/production/calendar-dates";

type Entry = { id: string; version: number; scheduledFor: string; timezone: string; itemId: string; title: string; channel: string; format: string; planId: string; planTitle: string; revisionVersion: number | null; revisionApproved: boolean; canMove: boolean; canRemove: boolean; reason: string | null };
type CalendarPage = { entries: Entry[]; nextCursor: string | null };
export function BusinessCalendar({ businessId }: { businessId: string }) {
  const router = useRouter();
  const [anchor, setAnchor] = useState(""), [view, setView] = useState<"month" | "week">("month"), [zone, setZone] = useState("UTC");
  const [cursors, setCursors] = useState<string[]>([]), [data, setData] = useState<CalendarPage | null>(null);
  const [loading, setLoading] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState(""), [refresh, setRefresh] = useState(0);
  const [day, setDay] = useState<string | null>(null), [dragged, setDragged] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ entry: Entry; action: "schedule" | "unschedule" } | null>(null), [date, setDate] = useState("");
  const editor = useRef<HTMLDivElement>(null), refreshButton = useRef<HTMLButtonElement>(null);
  const range = useMemo(() => { try { return calendarWindow(anchor, view); } catch { return null; } }, [anchor, view]);
  const cursor = cursors.at(-1);
  useEffect(() => { setAnchor(localDay(new Date())); setZone(Intl.DateTimeFormat().resolvedOptions().timeZone); }, []);
  useEffect(() => {
    if (!range) { setData(null); setLoading(false); return; }
    const abort = new AbortController(); setLoading(true); setData(null); setError("");
    const query = new URLSearchParams({ start: range.start, end: range.end, ...(cursor ? { after: cursor } : {}) });
    void fetch(`/api/businesses/${businessId}/calendar?${query}`, { signal: abort.signal }).then(async response => {
      const value = await response.json(); if (!response.ok) throw Error(value.error || "Unable to load calendar.");
      if (!abort.signal.aborted) setData(value);
    }).catch(err => { if (!abort.signal.aborted) setError(err instanceof Error ? err.message : "Unable to load calendar."); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [businessId, range, cursor, refresh]);
  useEffect(() => { if (edit) editor.current?.querySelector<HTMLInputElement | HTMLButtonElement>("input,button")?.focus(); }, [edit]);
  function reset() { setCursors([]); setDay(null); setEdit(null); setDragged(null); setNotice(""); }
  function close() { const id = edit?.entry.id; setEdit(null); setError(""); requestAnimationFrame(() => { const target = id ? document.getElementById(`calendar-move-${id}`) : null; if (target instanceof HTMLButtonElement && !target.disabled) target.focus(); else refreshButton.current?.focus(); }); }
  function open(entry: Entry, action: "schedule" | "unschedule", targetDay?: string) {
    setError(""); setNotice("");
    const old = new Date(entry.scheduledFor);
    setDate(targetDay ? `${targetDay}T${localMinute(old).slice(11)}` : localMinute(old));
    setEdit({ entry, action });
  }
  let preview = "";
  if (edit?.action === "schedule" && date) { try { const moment = parseLocalMinute(date); preview = `${moment.toLocaleString("en-GB", { timeZoneName: "shortOffset" })} · ${moment.toISOString()}`; } catch (err) { preview = err instanceof Error ? err.message : "Invalid time."; } }
  const entries = data?.entries.filter(entry => !day || localDay(new Date(entry.scheduledFor)) === day) ?? [];
  function step(direction: number) {
    if (!range) return;
    const next = new Date(range.start);
    if (view === "month") next.setMonth(next.getMonth() + direction); else next.setDate(next.getDate() + direction * 7);
    reset(); setAnchor(localDay(next));
  }
  return <section className="panel business-calendar" aria-busy={loading || saving}>
    <h2>All plans, one calendar</h2>
    <p className="notice">Internal reservations only—not proof of publication. Social publishing times, cancellations and receipts are managed separately in Publishing &amp; analytics. Times use your browser timezone: {zone}.</p>
    <div className="calendar-toolbar">
      <label>Calendar view<select value={view} disabled={saving} onChange={e => { reset(); setView(e.target.value as "month" | "week"); }}><option value="month">Month</option><option value="week">Week</option></select></label>
      <label>{view === "month" ? "Calendar month" : "Week containing"}<input type={view === "month" ? "month" : "date"} min={view === "month" ? "2000-01" : "2000-01-01"} max={view === "month" ? "2099-12" : "2099-12-31"} value={view === "month" ? anchor.slice(0, 7) : anchor} disabled={saving} onChange={e => { reset(); setAnchor(view === "month" && e.target.value ? `${e.target.value}-01` : e.target.value); }} /></label>
      <button className="button" disabled={saving || !range} onClick={() => step(-1)}>Previous {view}</button>
      <button className="button" disabled={saving || !range} onClick={() => step(1)}>Next {view}</button>
      <button ref={refreshButton} className="button" disabled={saving} onClick={() => { reset(); setRefresh(n => n + 1); }}>Refresh calendar</button>
    </div>
    <p role="alert" id="calendar-error" className="form-error">{error}</p>
    <p role="status">{loading ? "Loading calendar reservations…" : notice}</p>
    {!range && <p>Choose a valid calendar date between 2000 and 2099.</p>}
    {edit && <div ref={editor} className="notice" onKeyDown={e => { if (e.key === "Escape" && !saving) close(); }}>
      <h3>{edit.action === "schedule" ? "Move reservation" : "Remove reservation"}: {edit.entry.title}</h3>
      <form className="inline-form" onSubmit={async e => {
        e.preventDefault(); if (saving) return; setError("");
        let scheduledFor: string | undefined;
        try { if (edit.action === "schedule") scheduledFor = parseLocalMinute(date).toISOString(); } catch (err) { setError(err instanceof Error ? err.message : "Choose a valid date."); return; }
        setSaving(true);
        try {
          const response = await fetch(`/api/businesses/${businessId}/production`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: edit.action, itemId: edit.entry.itemId, expectedCalendar: { id: edit.entry.id, version: edit.entry.version }, ...(scheduledFor ? { version: edit.entry.revisionVersion, scheduledFor, timezone: zone } : {}) }) });
          const result = await response.json(); if (!response.ok) throw Error(result.error || "Unable to update reservation.");
          setEdit(null); setCursors([]); setRefresh(n => n + 1); setNotice("Internal reservation updated. No credits charged and no social post sent or changed."); router.refresh(); requestAnimationFrame(() => refreshButton.current?.focus());
        } catch (err) { setError(err instanceof Error ? err.message : "Unable to update reservation. Refresh before trying again."); }
        finally { setSaving(false); }
      }}>
        {edit.action === "schedule" ? <><label>New calendar date and time ({zone})<input type="datetime-local" required value={date} onChange={e => setDate(e.target.value)} aria-invalid={!!error} aria-describedby="calendar-error calendar-time-preview" /></label><p id="calendar-time-preview">Confirm this exact instant: {preview}</p></> : <p>Remove only this internal reservation? This does not delete the creative or change an actual social post.</p>}
        <div className="tag-row"><button className="button dark" disabled={saving}>{edit.action === "schedule" ? "Confirm new calendar time" : "Confirm reservation removal"}</button><button type="button" className="button" disabled={saving} onClick={close}>Cancel calendar change</button></div>
      </form>
    </div>}
    {range && <>
      <p>Choose a day to filter the agenda. Move reservations with the date form, or drag an agenda entry onto a day and confirm the proposed time.</p>
      <div className="calendar-grid" aria-label={`${view === "month" ? "Month" : "Week"} days`}>
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(label => <span className="calendar-weekday" key={label}>{label}</span>)}
        {Array.from({ length: range.offset }, (_, index) => <span key={`blank-${index}`} aria-hidden="true" />)}
        {range.days.map(key => {
          const count = data?.entries.filter(entry => localDay(new Date(entry.scheduledFor)) === key).length ?? 0;
          return <button key={key} className="calendar-day" disabled={loading || saving} aria-label={`${key}, ${count} reservations on this page`} aria-pressed={day === key}
            onClick={() => setDay(day === key ? null : key)} onDragOver={e => { if (dragged && !saving) e.preventDefault(); }} onDrop={e => {
              e.preventDefault(); const entry = data?.entries.find(row => row.id === dragged && row.canMove); setDragged(null); if (entry && !saving) open(entry, "schedule", key);
            }}><span>{Number(key.slice(-2))}</span><small>{count ? `${count} planned` : "—"}</small></button>;
        })}
      </div>
      {day && <button className="text-button" onClick={() => setDay(null)}>Show all days in this {view}</button>}
    </>}
    {!loading && data && <>
      {(cursor || data.nextCursor) && <p className="notice">This date range has multiple pages. Day counts and the agenda cover only this page (up to 100 reservations). Refresh after concurrent changes.</p>}
      <ol className="calendar-agenda">{entries.map(entry => <li key={entry.id} draggable={entry.canMove && !saving} onDragStart={e => { if (!entry.canMove || saving) { e.preventDefault(); return; } setDragged(entry.id); e.dataTransfer.setData("text/plain", "Internal calendar reservation"); e.dataTransfer.effectAllowed = "move"; }} onDragEnd={() => setDragged(null)}>
        <time dateTime={entry.scheduledFor}>{new Date(entry.scheduledFor).toLocaleString("en-GB", { timeZoneName: "short" })}</time>
        <div><h3>{entry.title}</h3><p>{entry.channel} · {entry.revisionApproved ? `approved version ${entry.revisionVersion}` : "review no longer current"}</p><p>Plan: {entry.planTitle}</p>{entry.reason && <p>{entry.reason}</p>}</div>
        <div className="tag-row"><button id={`calendar-move-${entry.id}`} className="button" disabled={saving || !entry.canMove} onClick={() => open(entry, "schedule")}>Move {entry.title}</button><button className="text-button" disabled={saving || !entry.canRemove} onClick={() => open(entry, "unschedule")}>Remove {entry.title}</button></div>
      </li>)}</ol>
      {!entries.length && <p>No reservations on this page for the selected dates. Place approved work on the calendar from the Review inbox.</p>}
      <div className="tag-row"><button className="button" disabled={saving || !cursor} onClick={() => { setEdit(null); setCursors(value => value.slice(0, -1)); }}>Previous calendar page</button><button className="button" disabled={saving || !data.nextCursor} onClick={() => { setEdit(null); setCursors(value => [...value, data.nextCursor!]); }}>Next calendar page</button></div>
    </>}
  </section>;
}
