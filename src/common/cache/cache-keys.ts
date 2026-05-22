/**
 * Centralised cache-key factory. Putting them here keeps the key naming scheme
 * grep-able and prevents drift between the producer (the service that sets the
 * cache) and the consumer (the invalidation service that deletes it).
 */
export const CacheKeys = {
  syncInit: (sid: string) => `sync:init:${sid}` as const,
  productByBarcode: (sid: string, barcode: string) =>
    `product:barcode:${sid}:${barcode}` as const,
  dailyProfit: (sid: string, dayIso: string) =>
    `report:daily-profit:${sid}:${dayIso}` as const,
};

export const CacheTtl = {
  SYNC_INIT: 30 * 1000, // 30s — short, since invalidation is best-effort
  PRODUCT_BARCODE: 5 * 60 * 1000, // 5min — cashier hits this with every scan
  DAILY_PROFIT_PAST: 24 * 60 * 60 * 1000, // 24h — past days are immutable
} as const;
