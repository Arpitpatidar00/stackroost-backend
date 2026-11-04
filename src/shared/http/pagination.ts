import { z } from 'zod';

/** Every list endpoint is paginated: page ≥ 1, 1 ≤ limit ≤ 100. */
export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type PageRequest = z.infer<typeof paginationQuery>;

export interface Page<T> {
  items: T[];
  total: number;
}

export const pageMeta = (req: PageRequest, total: number) => ({
  page: req.page,
  limit: req.limit,
  total,
  pages: Math.ceil(total / req.limit),
});

export const skipTake = ({ page, limit }: PageRequest) => ({
  skip: (page - 1) * limit,
  take: limit,
});
