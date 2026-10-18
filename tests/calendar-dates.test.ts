import { afterEach, describe, expect, it, vi } from "vitest";
import { calendarWindow, localMinute, parseLocalMinute } from "../src/lib/production/calendar-dates";
describe("browser-local calendar windows and wall-clock validation", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("builds leap months and Monday-based weeks without mutating dates", () => {
    vi.stubEnv("TZ", "UTC");
    const month = calendarWindow("2028-02-10", "month")!;
    expect(month.days).toHaveLength(29); expect(month.start).toBe("2028-02-01T00:00:00.000Z");
    expect(calendarWindow("2026-10-18", "week")!.days).toEqual(["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"]);
    expect(calendarWindow("", "month")).toBeNull(); expect(calendarWindow("1900-01-01", "month")).toBeNull();
  });
  it("rejects invalid dates and round-trips valid local minutes", () => {
    vi.stubEnv("TZ", "UTC");
    for (const value of ["2026-02-30T12:00", "not a date", "2026-10-01T24:00"]) expect(() => parseLocalMinute(value)).toThrow();
    expect(localMinute(parseLocalMinute("2026-10-18T12:30"))).toBe("2026-10-18T12:30");
  });
  it("rejects spring DST gaps and preserves calendar weeks across both transitions", () => {
    vi.stubEnv("TZ", "America/New_York");
    expect(() => parseLocalMinute("2027-03-14T02:30")).toThrow("does not exist");
    const spring = calendarWindow("2027-03-14", "week")!;
    const autumn = calendarWindow("2027-11-07", "week")!;
    expect(spring.days).toHaveLength(7); expect(autumn.days).toHaveLength(7);
    expect((Date.parse(spring.end) - Date.parse(spring.start)) / 3600000).toBe(167);
    expect((Date.parse(autumn.end) - Date.parse(autumn.start)) / 3600000).toBe(169);
    // Repeated autumn wall-clock minutes use the browser's first occurrence.
    expect(parseLocalMinute("2027-11-07T01:30").toISOString()).toBe("2027-11-07T05:30:00.000Z");
  });
});
