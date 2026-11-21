// Dates. The Sheet prototype works in its script time zone (America/Chicago); so does this.
export const RPZ_TZ = 'America/Chicago';

/** Offset of a time zone from UTC at a moment, in seconds (e.g. -18000 for CDT). */
export function tzOffset(epochSec: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(epochSec * 1000));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return (Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second')) / 1000) - epochSec;
}

/** Epoch seconds of local midnight starting the day YYYY-MM-DD, or null if not a date. */
export function dayStart(ymd: string | null | undefined, tz = RPZ_TZ): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '');
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3]) / 1000;
  const first = guess - tzOffset(guess, tz);
  return guess - tzOffset(first, tz);   // second pass settles DST-change days
}

export interface CountWindow { from: number; to: number }

/** Rides count from count_from (inclusive) through count_to (inclusive); null = no limits. */
export function countWindow(from: string | null, to: string | null): CountWindow | null {
  const f = dayStart(from), t = dayStart(to);
  if (f === null && t === null) return null;
  return { from: f ?? -Infinity, to: t === null ? Infinity : (dayStart(addDays(to!, 1)) as number) };
}
export function inWindow(win: CountWindow | null, riddenAt: number): boolean {
  return !win || (riddenAt >= win.from && riddenAt < win.to);
}

/** YYYY-MM-DD plus n days (calendar arithmetic, no time zone involved). */
export function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Display only: Monday of a program's Week 1, working back from count_to (= last Sunday + 7 days). */
export function programWeek1(countTo: string | null, weeks: number): string {
  if (!countTo || !/^\d{4}-\d{2}-\d{2}$/.test(countTo) || !weeks) return '';
  return addDays(countTo, -7 - 7 * weeks + 1);
}
