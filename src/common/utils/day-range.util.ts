/**
 * Calendar-day boundaries in a named IANA time zone.
 *
 * Reports are asked for a day the way the shop counts days — "18 August" means
 * the shop's own midnight-to-midnight, not UTC's. Bucketing on the UTC calendar
 * silently shifts the window by the zone's offset, which drops every sale rung
 * up between local midnight and that offset into the previous day.
 *
 * Zone rules are read from the runtime's tzdata via `Intl`, so DST is handled
 * without pinning a fixed offset (Palestine is UTC+2 in winter, UTC+3 in
 * summer, and switches *at midnight* — which is why the awkward cases below
 * are real rather than theoretical).
 */

export interface DayRange {
  /** Inclusive lower bound: the first instant of the local day. */
  start: Date;
  /** Exclusive upper bound: the first instant of the next local day. */
  end: Date;
  /** The local calendar day the range covers, as YYYY-MM-DD. */
  dayIso: string;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** A bare calendar date, as opposed to a full ISO instant. */
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Formatters are expensive to build and these are hot paths, so memoise. */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * The zone's wall-clock reading at `instant`, expressed as the UTC timestamp
 * that would show those same digits. Comparing this against the real timestamp
 * is what yields the offset.
 */
function wallClockAsUtcMs(instant: Date, timeZone: string): number {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const read: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== 'literal') read[part.type] = Number(part.value);
  }
  return Date.UTC(
    read.year,
    read.month - 1,
    read.day,
    read.hour,
    read.minute,
    read.second,
  );
}

function offsetMsAt(instant: Date, timeZone: string): number {
  // formatToParts resolves to whole seconds, so drop millis before comparing.
  const whole = Math.floor(instant.getTime() / 1000) * 1000;
  return wallClockAsUtcMs(instant, timeZone) - whole;
}

/**
 * The instant local midnight of the given date begins in `timeZone`.
 *
 * A naive `wanted - offset` is not enough: the offset depends on the instant
 * we are still solving for. Probing the neighbouring days yields every offset
 * that could plausibly apply, and the wall clock decides between them.
 */
function startOfLocalDay(
  year: number,
  month: number,
  day: number,
  timeZone: string,
): Date {
  const wanted = Date.UTC(year, month - 1, day, 0, 0, 0);

  const candidates = new Set<number>();
  for (const probe of [wanted - MS_PER_DAY, wanted, wanted + MS_PER_DAY]) {
    candidates.add(wanted - offsetMsAt(new Date(probe), timeZone));
  }

  const lands = [...candidates]
    .filter((ms) => wallClockAsUtcMs(new Date(ms), timeZone) === wanted)
    .sort((a, b) => a - b);

  // Autumn fall-back: local midnight happens twice. The day starts at the first.
  if (lands.length > 0) return new Date(lands[0]);

  // Spring forward *at* midnight: 00:00 never reads on the clock, so the day
  // begins the instant the clock jumps into it — the latest candidate.
  return new Date(Math.max(...candidates));
}

/** The local calendar date at `instant`, as YYYY-MM-DD. */
function localDayIso(instant: Date, timeZone: string): string {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const read: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') read[part.type] = part.value;
  }
  return `${read.year}-${read.month}-${read.day}`;
}

/**
 * Resolve a `YYYY-MM-DD` string (or "now") to that calendar day's bounds in
 * `timeZone`.
 *
 * `end` is exclusive — query with `gte: start, lt: end`. An inclusive
 * `23:59:59.999` bound leaves a one-millisecond hole and needs re-deriving
 * whenever precision changes; a half-open interval never does.
 */
export function dayRangeInZone(
  dateStr: string | undefined,
  timeZone: string,
): DayRange {
  let year: number;
  let month: number;
  let day: number;

  const supplied = dateStr?.trim();

  if (supplied && CALENDAR_DATE.test(supplied)) {
    // A bare calendar date already names the day — nothing to convert.
    [year, month, day] = supplied.split('-').map(Number);
  } else {
    // Either an instant or nothing. IsDateString accepts full ISO, so a
    // caller sending new Date().toISOString() arrives here as a UTC instant;
    // taking its first ten characters would reinstate the bug this fixes.
    // Both cases resolve to whichever local day the moment belongs to.
    const parsed = supplied ? new Date(supplied) : new Date();
    const instant = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
    const [y, m, d] = localDayIso(instant, timeZone).split('-');
    year = Number(y);
    month = Number(m);
    day = Number(d);
  }

  const start = startOfLocalDay(year, month, day, timeZone);

  // Step by calendar date rather than by +24h: DST days are 23 or 25 hours.
  const nextUtc = new Date(Date.UTC(year, month - 1, day) + MS_PER_DAY);
  const end = startOfLocalDay(
    nextUtc.getUTCFullYear(),
    nextUtc.getUTCMonth() + 1,
    nextUtc.getUTCDate(),
    timeZone,
  );

  const pad = (n: number) => String(n).padStart(2, '0');

  return { start, end, dayIso: `${year}-${pad(month)}-${pad(day)}` };
}
