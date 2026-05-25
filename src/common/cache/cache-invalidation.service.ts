import { Inject, Injectable, Logger } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { CacheKeys } from './cache-keys';

/**
 * Thin wrapper around the cache so write paths can fire a one-liner to bust
 * the relevant entries without learning the key scheme. All methods are
 * fire-and-forget tolerant: a cache failure must never block a DB write.
 */
@Injectable()
export class CacheInvalidationService {
  private readonly logger = new Logger(CacheInvalidationService.name);
  // Per-store register of cached daily-profit dates so we can blanket-invalidate
  // when an invoice changes for a store without knowing which day it fell on.
  // Kept in memory because the cache itself is in-memory; if we move to Redis
  // later, replace this with a Redis SET per store.
  private readonly dailyProfitKeysByStore = new Map<string, Set<string>>();

  constructor(@Inject(CACHE_MANAGER) private readonly cache: Cache) {}

  trackDailyProfitKey(sid: string, dayIso: string): void {
    let set = this.dailyProfitKeysByStore.get(sid);
    if (!set) {
      set = new Set();
      this.dailyProfitKeysByStore.set(sid, set);
    }
    set.add(dayIso);
  }

  async invalidateSyncInit(sid: string): Promise<void> {
    await this.safeDel(CacheKeys.syncInit(sid));
  }

  async invalidateStoreStatus(sid: string): Promise<void> {
    await this.safeDel(CacheKeys.storeStatus(sid));
  }

  async invalidateProductBarcode(sid: string, barcode: string | null): Promise<void> {
    if (!barcode) return;
    await this.safeDel(CacheKeys.productByBarcode(sid, barcode));
  }

  async invalidateAllDailyProfit(sid: string): Promise<void> {
    const set = this.dailyProfitKeysByStore.get(sid);
    if (!set || set.size === 0) return;
    await Promise.all(
      [...set].map((day) => this.safeDel(CacheKeys.dailyProfit(sid, day))),
    );
    set.clear();
  }

  /**
   * Invalidate everything that depends on writes within a store: PWA init
   * snapshot, daily-profit windows, and (optionally) a specific product
   * barcode. Catch-all used by product/customer/debt write paths.
   */
  async invalidateStoreData(
    sid: string,
    opts: { barcode?: string | null } = {},
  ): Promise<void> {
    await Promise.all([
      this.invalidateSyncInit(sid),
      this.invalidateAllDailyProfit(sid),
      opts.barcode !== undefined
        ? this.invalidateProductBarcode(sid, opts.barcode)
        : Promise.resolve(),
    ]);
  }

  private async safeDel(key: string): Promise<void> {
    try {
      await this.cache.del(key);
    } catch (err) {
      // A cache failure must never poison a DB write. Log + swallow.
      this.logger.warn(`Cache invalidation failed for key "${key}": ${err}`);
    }
  }
}
