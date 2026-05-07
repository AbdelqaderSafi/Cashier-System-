import { ForbiddenException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export interface DailyProfitResult {
  date: string;
  totalRevenue: number;
  totalCost: number;
  netProfit: number;
}

@Injectable()
export class ReportsService {
  constructor(private readonly db: DatabaseService) {}

  private requireStoreId(storeId: string | null): string {
    if (!storeId) throw new ForbiddenException('Store context is required for this operation');
    return storeId;
  }

  /**
   * Calculates the net profit for a given calendar day.
   *
   * Revenue = Σ (item.price × item.quantity)
   * Cost    = Σ (item.unitCost × item.quantity)
   * Profit  = Revenue − Cost
   *
   * Both revenue and cost are read from InvoiceItem so historical records
   * are never affected by future price/cost changes on the Product row.
   */
  async getDailyProfit(storeId: string | null, dateStr?: string): Promise<DailyProfitResult> {
    const sid = this.requireStoreId(storeId);

    // Resolve target date (defaults to today in UTC)
    const target = dateStr ? new Date(dateStr) : new Date();
    const dayStart = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate(), 0, 0, 0));
    const dayEnd = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate(), 23, 59, 59, 999));

    // Aggregate directly in the DB for efficiency — one round-trip.
    const result = await this.db.invoiceItem.aggregate({
      where: {
        invoice: {
          storeId: sid,
          date: { gte: dayStart, lte: dayEnd },
        },
      },
      _sum: {
        total: true,    // price × quantity already stored
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
        AND  i.date BETWEEN ${dayStart} AND ${dayEnd}
    `;

    const totalRevenue = Number(result._sum.total ?? 0);
    const totalCost = Number(costRows[0]?.total_cost ?? 0);
    const netProfit = +(totalRevenue - totalCost).toFixed(2);

    return {
      date: dayStart.toISOString().slice(0, 10),
      totalRevenue: +totalRevenue.toFixed(2),
      totalCost: +totalCost.toFixed(2),
      netProfit,
    };
  }
}
