import { dayRangeInZone } from './day-range.util';

/**
 * The reports used to bucket a "day" on the UTC calendar while the shop runs
 * at UTC+3, so every sale rung up between local midnight and 03:00 was filed
 * under the previous day and vanished from "today". These lock the boundaries
 * to the shop's own clock.
 *
 * Expected instants are derived from published zone rules, not from the
 * implementation: Asia/Amman has been a fixed UTC+3 with no DST since 2022,
 * and Europe/London springs forward on the last Sunday of March.
 */
describe('dayRangeInZone', () => {
  describe('fixed-offset zone (Asia/Amman, UTC+3 year-round)', () => {
    it('starts the day at local midnight, not UTC midnight', () => {
      const { start } = dayRangeInZone('2026-08-18', 'Asia/Amman');
      expect(start.toISOString()).toBe('2026-08-17T21:00:00.000Z');
    });

    it('ends the day at the next local midnight (exclusive)', () => {
      const { end } = dayRangeInZone('2026-08-18', 'Asia/Amman');
      expect(end.toISOString()).toBe('2026-08-18T21:00:00.000Z');
    });

    it('covers a sale rung up at 00:30 local — the bug this fixes', () => {
      const { start, end } = dayRangeInZone('2026-08-18', 'Asia/Amman');
      const saleAt0030Local = new Date('2026-08-18T00:30:00+03:00');

      expect(saleAt0030Local.getTime()).toBeGreaterThanOrEqual(start.getTime());
      expect(saleAt0030Local.getTime()).toBeLessThan(end.getTime());
    });

    it('excludes a sale rung up at 00:30 local the following day', () => {
      const { end } = dayRangeInZone('2026-08-18', 'Asia/Amman');
      const nextDay = new Date('2026-08-19T00:30:00+03:00');

      expect(nextDay.getTime()).toBeGreaterThanOrEqual(end.getTime());
    });

    it('reports the local calendar day, not the UTC one', () => {
      const { dayIso } = dayRangeInZone('2026-08-18', 'Asia/Amman');
      expect(dayIso).toBe('2026-08-18');
    });
  });

  describe('UTC zone', () => {
    it('falls back to plain UTC midnights', () => {
      const { start, end } = dayRangeInZone('2026-08-18', 'UTC');
      expect(start.toISOString()).toBe('2026-08-18T00:00:00.000Z');
      expect(end.toISOString()).toBe('2026-08-19T00:00:00.000Z');
    });
  });

  describe('DST transitions (Europe/London)', () => {
    it('spring-forward day is 23 hours long, not 24', () => {
      const { start, end } = dayRangeInZone('2026-03-29', 'Europe/London');
      expect(start.toISOString()).toBe('2026-03-29T00:00:00.000Z');
      expect(end.toISOString()).toBe('2026-03-29T23:00:00.000Z');
      expect(end.getTime() - start.getTime()).toBe(23 * 60 * 60 * 1000);
    });

    it('autumn-back day is 25 hours long', () => {
      const { start, end } = dayRangeInZone('2026-10-25', 'Europe/London');
      expect(end.getTime() - start.getTime()).toBe(25 * 60 * 60 * 1000);
    });
  });

  describe('no date supplied', () => {
    it("uses the zone's current calendar day, not the server's", () => {
      // Fixed instant: 2026-08-18 00:30 in Amman, still 2026-08-17 in UTC.
      const at0030Local = new Date('2026-08-17T21:30:00.000Z');
      jest.useFakeTimers().setSystemTime(at0030Local);

      try {
        const { dayIso, start, end } = dayRangeInZone(undefined, 'Asia/Amman');

        expect(dayIso).toBe('2026-08-18');
        expect(at0030Local.getTime()).toBeGreaterThanOrEqual(start.getTime());
        expect(at0030Local.getTime()).toBeLessThan(end.getTime());
      } finally {
        jest.useRealTimers();
      }
    });
  });
});

/**
 * Asia/Hebron is the shop's zone and it switches DST *at midnight*, so local
 * midnight is sometimes skipped (spring) and sometimes happens twice (autumn).
 * Asserting fixed instants here would pin the test to whatever transition dates
 * ship in the current tzdata, so these assert the properties that must hold on
 * every day of the year instead.
 */
describe('dayRangeInZone — whole-year invariants (Asia/Hebron)', () => {
  const ZONE = 'Asia/Hebron';

  const everyDayOf2026 = (): string[] => {
    const days: string[] = [];
    const cursor = new Date(Date.UTC(2026, 0, 1));
    while (cursor.getUTCFullYear() === 2026) {
      days.push(cursor.toISOString().slice(0, 10));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return days;
  };

  const localDateOf = (instant: Date): string =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(instant);

  it('starts each day at the first instant that reads as that local date', () => {
    for (const day of everyDayOf2026()) {
      const { start } = dayRangeInZone(day, ZONE);

      expect({ day, at: localDateOf(start) }).toEqual({ day, at: day });
      expect({
        day,
        justBefore: localDateOf(new Date(start.getTime() - 1)),
      }).not.toEqual({ day, justBefore: day });
    }
  });

  it('ends each day at the first instant that reads as the next local date', () => {
    for (const day of everyDayOf2026()) {
      const { end } = dayRangeInZone(day, ZONE);

      expect({ day, at: localDateOf(end) }).not.toEqual({ day, at: day });
      expect({
        day,
        justBefore: localDateOf(new Date(end.getTime() - 1)),
      }).toEqual({ day, justBefore: day });
    }
  });

  it('tiles consecutive days with no gap and no overlap', () => {
    const days = everyDayOf2026();
    for (let i = 0; i < days.length - 1; i++) {
      const today = dayRangeInZone(days[i], ZONE);
      const tomorrow = dayRangeInZone(days[i + 1], ZONE);

      expect({ day: days[i], boundary: today.end.toISOString() }).toEqual({
        day: days[i],
        boundary: tomorrow.start.toISOString(),
      });
    }
  });

  it('never produces an empty or backwards range', () => {
    for (const day of everyDayOf2026()) {
      const { start, end } = dayRangeInZone(day, ZONE);
      expect({ day, ok: end.getTime() > start.getTime() }).toEqual({
        day,
        ok: true,
      });
    }
  });
});

/**
 * The `date` query param is validated with @IsDateString(), which accepts a
 * full ISO instant as readily as a plain calendar date. A frontend sending
 * `new Date().toISOString()` therefore reaches us as a UTC instant, and
 * slicing its first ten characters would reintroduce the very bug this fixes:
 * at 00:27 local the instant still reads as the previous UTC date.
 *
 * A plain date is a calendar date and stays literal. Anything carrying a time
 * is an instant, and the day it belongs to is decided in the shop's zone.
 */
describe('dayRangeInZone — instants vs. calendar dates', () => {
  const ZONE = 'Asia/Hebron'; // UTC+3 in August

  it('treats a plain YYYY-MM-DD as a literal calendar date', () => {
    expect(dayRangeInZone('2026-08-18', ZONE).dayIso).toBe('2026-08-18');
  });

  it('resolves a UTC instant to the local day it falls in', () => {
    // 21:00Z on the 17th *is* local midnight on the 18th.
    expect(dayRangeInZone('2026-08-17T21:00:00.000Z', ZONE).dayIso).toBe(
      '2026-08-18',
    );
  });

  it('resolves the reported 00:27 moment sent as an instant', () => {
    expect(dayRangeInZone('2026-08-17T21:27:00.000Z', ZONE).dayIso).toBe(
      '2026-08-18',
    );
  });

  it('honours an explicit offset in the instant', () => {
    expect(dayRangeInZone('2026-08-18T00:27:00+03:00', ZONE).dayIso).toBe(
      '2026-08-18',
    );
  });

  it('keeps an instant that is mid-afternoon on the same day', () => {
    expect(dayRangeInZone('2026-08-18T09:00:00.000Z', ZONE).dayIso).toBe(
      '2026-08-18',
    );
  });

  it('rolls an instant past local midnight into the next day', () => {
    // 21:30Z on the 18th is 00:30 local on the 19th.
    expect(dayRangeInZone('2026-08-18T21:30:00.000Z', ZONE).dayIso).toBe(
      '2026-08-19',
    );
  });

  it('falls back to today when the string is not a usable date', () => {
    const today = dayRangeInZone(undefined, ZONE).dayIso;
    expect(dayRangeInZone('not-a-date', ZONE).dayIso).toBe(today);
  });
});

/**
 * Every other zone exercised here sits at or ahead of UTC, which hides a whole
 * class of mistake: `new Date('2026-08-18')` parses as UTC midnight, and in a
 * zone ahead of UTC that instant still reads as the 18th, so a calendar date
 * routed accidentally through instant-resolution still comes out right. West
 * of UTC it comes out a day early. These lock that direction down.
 */
describe('dayRangeInZone — zones behind UTC (America/New_York, UTC-4 in August)', () => {
  const ZONE = 'America/New_York';

  it('keeps a bare calendar date on the date it names', () => {
    expect(dayRangeInZone('2026-08-18', ZONE).dayIso).toBe('2026-08-18');
  });

  it('starts that day at local midnight, which is later in UTC', () => {
    expect(dayRangeInZone('2026-08-18', ZONE).start.toISOString()).toBe(
      '2026-08-18T04:00:00.000Z',
    );
  });

  it('ends that day at the next local midnight', () => {
    expect(dayRangeInZone('2026-08-18', ZONE).end.toISOString()).toBe(
      '2026-08-19T04:00:00.000Z',
    );
  });

  it('still resolves a genuine instant to its local day', () => {
    // 03:00Z on the 18th is 23:00 on the 17th in New York.
    expect(dayRangeInZone('2026-08-18T03:00:00.000Z', ZONE).dayIso).toBe(
      '2026-08-17',
    );
  });
});
