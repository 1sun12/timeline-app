// Date math for the timeline axis.
// Years are historical (1 BCE = -1, no year 0). The axis uses "astronomical"
// fractional years (1 BCE = 0) so the scale is continuous across the era change.

export interface Dated {
  year: number;
  month?: number | null;
  day?: number | null;
  hour?: number | null;
  minute?: number | null;
}

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const toAstro = (year: number) => (year > 0 ? year : year + 1);
export const fromAstro = (a: number) => (a > 0 ? a : a - 1);

const mod = (n: number, m: number) => ((n % m) + m) % m;
export const isLeap = (astro: number) => (mod(astro, 4) === 0 && mod(astro, 100) !== 0) || mod(astro, 400) === 0;

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeap(toAstro(year)) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Position of a date on the axis, in fractional astronomical years. */
export function axisValue(d: Dated): number {
  const a = toAstro(d.year);
  if (!d.month) return a;
  let days = 0;
  for (let m = 1; m < d.month; m++) days += daysInMonth(d.year, m);
  days += (d.day ?? 1) - 1;
  days += ((d.hour ?? 0) + (d.minute ?? 0) / 60) / 24;
  return a + days / (isLeap(a) ? 366 : 365);
}

/** Years beyond this lose day precision in floating point; nothing real is that old. */
export const MAX_YEARS = 1e12;

const full = (n: number) => (n >= 10000 ? n.toLocaleString("en-US") : String(n));

/** Exact year for cards and fields: "428 BCE", "50 AD", "1066", "66,000,000 BCE". */
export function formatYear(year: number): string {
  if (year < 0) return `${full(-year)} BCE`;
  return year < 1000 ? `${year} AD` : full(year);
}

/** Compact year for axis ticks: "250,000 BCE", "66 million BCE", "4.5 billion BCE". */
export function tickLabel(year: number): string {
  const n = Math.abs(year);
  const era = year < 0 ? " BCE" : n < 1000 ? " AD" : "";
  const short = (v: number) => String(+v.toPrecision(3));
  if (n >= 1e9) return `${short(n / 1e9)} billion${era || " AD"}`;
  if (n >= 1e6) return `${short(n / 1e6)} million${era || " AD"}`;
  return `${full(n)}${era}`;
}

export function formatDate(d: Dated): string {
  let s = formatYear(d.year);
  if (d.month) s = `${MONTHS[d.month - 1]} ${s}`;
  if (d.month && d.day) s = `${d.day} ${s}`;
  if (d.hour != null) s += `, ${String(d.hour).padStart(2, "0")}:${String(d.minute ?? 0).padStart(2, "0")}`;
  return s;
}

/** The date at an axis position, as precise as the zoom level makes meaningful. */
export function dateAt(t: number, pxPerYear: number): Dated {
  const a = Math.floor(t);
  const year = fromAstro(a);
  if (pxPerYear < 240) return { year };
  let days = (t - a) * (isLeap(a) ? 366 : 365);
  let month = 1;
  while (month < 12 && days >= daysInMonth(year, month)) days -= daysInMonth(year, month++);
  return pxPerYear < 4000 ? { year, month } : { year, month, day: Math.floor(days) + 1 };
}

export interface Tick {
  t: number;
  label: string;
  major: boolean;
}

const NICE = [1, 2, 5];

/** Axis ticks for the visible range [t0, t1]. */
export function ticks(t0: number, t1: number, pxPerYear: number): Tick[] {
  const out: Tick[] = [];
  let step = 1;
  for (let p = 0; ; p++) {
    const s = NICE[p % 3] * 10 ** Math.floor(p / 3);
    if (s * pxPerYear >= 120 || s >= 1e13) {
      step = s;
      break;
    }
  }
  // Ticks sit on round historical years; year 0 doesn't exist so it is skipped.
  const h0 = Math.floor(fromAstro(Math.floor(t0)) / step) * step;
  const h1 = Math.ceil(fromAstro(Math.ceil(t1)) / step) * step;
  for (let h = h0; h <= h1 && out.length < 400; h += step) {
    if (h !== 0) out.push({ t: toAstro(h), label: tickLabel(h), major: true });
  }
  if (pxPerYear >= 600) {
    for (let a = Math.floor(t0); a <= Math.ceil(t1); a++) {
      for (let m = 2; m <= 12; m++) {
        const t = axisValue({ year: fromAstro(a), month: m });
        if (t >= t0 && t <= t1) out.push({ t, label: pxPerYear >= 1100 ? MONTHS[m - 1] : "", major: false });
      }
    }
  }
  return out;
}
