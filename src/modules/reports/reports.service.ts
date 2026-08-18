import { Inject, Injectable } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { DatabaseService } from '../database/database.service';
import { CacheKeys, CacheTtl } from '../../common/cache/cache-keys';
import { CacheInvalidationService } from '../../common/cache/cache-invalidation.service';
import { dayRangeInZone } from '../../common/utils/day-range.util';
import { env } from '../../common/config/env';

export interface DailyProfitResult {
  date: string;
  totalRevenue: number;
  totalCost: number;
  netProfit: number;
}

@Injectable()
export class ReportsService {
  constructor(
    private readonly db: DatabaseService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    private readonly cacheInvalidator: CacheInvalidationService,
  ) {}

  /**
   * Calculates the net profit for a given calendar day.
   *
   * Revenue = Σ (item.price × item.quantity) − Σ (invoice.discount)
   * Cost    = Σ (item.unitCost × item.quantity)
   * Profit  = Revenue − Cost
   *
   * Both revenue and cost are read from InvoiceItem so historical records
   * are never affected by future price/cost changes on the Product row.
   */
  async getDailyProfit(
    sid: string,
    dateStr?: string,
  ): Promise<DailyProfitResult> {
    // Resolve the target day on the shop's clock. Reading it off UTC shifts
    // the window by the zone offset, which files every sale rung up between
    // local midnight and that offset under the previous day.
    const {
      start: dayStart,
      end: dayEnd,
      dayIso,
    } = dayRangeInZone(dateStr, env.STORE_TIMEZONE);

    // Only cache *past* days — they're immutable. Today is still changing, so
    // we always re-fetch to avoid stale numbers. "Past" is judged against the
    // shop's current day, not the container's.
    const todayStart = dayRangeInZone(undefined, env.STORE_TIMEZONE).start;
    const isPastDay = dayStart.getTime() < todayStart.getTime();
    const cacheKey = CacheKeys.dailyProfit(sid, dayIso);

    if (isPastDay) {
      const cached = await this.cache.get<DailyProfitResult>(cacheKey);
      if (cached) return cached;
    }

    // Aggregate directly in the DB for efficiency — one round-trip.
    const result = await this.db.invoiceItem.aggregate({
      where: {
        invoice: {
          storeId: sid,
          date: { gte: dayStart, lt: dayEnd },
        },
      },
      _sum: {
        total: true, // price × quantity already stored
        quantity: true, // kept for possible future use
      },
    });

    // unitCost × quantity must be summed manually because Prisma aggregate
    // does not support computed columns.  We use a raw query scoped to the
    // store via the invoice join.
    const costRows = await this.db.$queryRaw<{ total_cost: string }[]>`
      SELECT COALESCE(SUM(ii."unitCost" * ii."quantity"), 0)::text AS total_cost
      FROM   invoice_items ii
      JOIN   invoices       i  ON i.id = ii."invoiceId"
      WHERE  i."storeId" = ${sid}
        AND  i.date >= ${dayStart}
        AND  i.date <  ${dayEnd}
    `;

    // Invoice-level discounts live on the invoice, not on its lines, so the
    // line-sum revenue above is the GROSS. Subtract the day's discounts or
    // every discount given is reported as profit.
    const discountRows = await this.db.$queryRaw<{ total_discount: string }[]>`
      SELECT COALESCE(SUM(i."discount"), 0)::text AS total_discount
      FROM   invoices i
      WHERE  i."storeId" = ${sid}
        AND  i.date >= ${dayStart}
        AND  i.date <  ${dayEnd}
    `;

    const grossRevenue = Number(result._sum.total ?? 0);
    const totalDiscount = Number(discountRows[0]?.total_discount ?? 0);
    const totalRevenue = grossRevenue - totalDiscount;
    const totalCost = Number(costRows[0]?.total_cost ?? 0);
    const netProfit = +(totalRevenue - totalCost).toFixed(2);

    const dailyProfit: DailyProfitResult = {
      date: dayIso,
      totalRevenue: +totalRevenue.toFixed(2),
      totalCost: +totalCost.toFixed(2),
      netProfit,
    };

    if (isPastDay) {
      await this.cache.set(cacheKey, dailyProfit, CacheTtl.DAILY_PROFIT_PAST);
      this.cacheInvalidator.trackDailyProfitKey(sid, dayIso);
    }

    return dailyProfit;
  }
}
