export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 20;

export type PaginatedMeta = {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

export type PaginatedResult<T> = {
  data: T[];
  meta: PaginatedMeta;
};

/**
 * Normalises `page` and `limit` from a query DTO into safe Prisma
 * `{ skip, take }` values. Caps `take` at MAX_PAGE_SIZE to prevent DoS via
 * `?limit=999999`. Clamps `page` to >= 1.
 */
export function paginate(
  options: { page?: number; limit?: number } = {},
): { skip: number; take: number; page: number; limit: number } {
  const rawLimit = options.limit ?? DEFAULT_PAGE_SIZE;
  const rawPage = options.page ?? 1;

  const take = Math.min(Math.max(Math.floor(rawLimit), 1), MAX_PAGE_SIZE);
  const page = Math.max(Math.floor(rawPage), 1);

  return { skip: (page - 1) * take, take, page, limit: take };
}

export function paginatedResponse<T>(
  data: T[],
  total: number,
  page: number,
  limit: number,
): PaginatedResult<T> {
  return {
    data,
    meta: {
      total,
      page,
      limit,
      totalPages: limit > 0 ? Math.ceil(total / limit) : 0,
    },
  };
}
