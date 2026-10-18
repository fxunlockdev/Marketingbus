// Browser-local wall-clock helpers. No arbitrary-zone parsing or silent DST gap shifts.
export function localDay(value: Date) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}
export function localMinute(value: Date) {
  return `${localDay(value)}T${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`;
}
export function parseLocalMinute(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw Error("Choose a valid local date and time.");
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || localMinute(date) !== value) throw Error("That local time does not exist. Choose another time, including across daylight-saving changes.");
  return date;
}
export function calendarWindow(anchor: string, view: "month" | "week") {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor)) return null;
  if (Number(anchor.slice(0, 4)) < 2000 || Number(anchor.slice(0, 4)) > 2099) return null;
  const date = parseLocalMinute(`${anchor}T12:00`);
  const start = view === "month" ? new Date(date.getFullYear(), date.getMonth(), 1) : new Date(date.getFullYear(), date.getMonth(), date.getDate() - (date.getDay() + 6) % 7);
  const end = view === "month" ? new Date(start.getFullYear(), start.getMonth() + 1, 1) : new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
  const days: string[] = [];
  for (let d = new Date(start); d < end; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) days.push(localDay(d));
  return { start: start.toISOString(), end: end.toISOString(), days, offset: (start.getDay() + 6) % 7 };
}
