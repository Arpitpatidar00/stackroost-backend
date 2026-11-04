import type { Coupon } from '@/generated/prisma/client';
import type { DbClient } from '@/db/prisma';
import { skipTake, type Page, type PageRequest } from '@/shared/http/pagination';

export type CouponCreate = Omit<Coupon, 'id' | 'isActive' | 'createdAt' | 'updatedAt'>;

export interface CouponsRepository {
  create(input: CouponCreate): Promise<Coupon>;
  findById(id: string): Promise<Coupon | null>;
  findByCode(code: string): Promise<Coupon | null>;
  list(filter: { active?: boolean }, page: PageRequest): Promise<Page<Coupon>>;
  setActive(id: string, isActive: boolean): Promise<Coupon>;
}

export class PrismaCouponsRepository implements CouponsRepository {
  constructor(private readonly db: DbClient) {}

  create(input: CouponCreate) {
    return this.db.coupon.create({ data: input });
  }

  findById(id: string) {
    return this.db.coupon.findUnique({ where: { id } });
  }

  findByCode(code: string) {
    return this.db.coupon.findUnique({ where: { code } });
  }

  async list(filter: { active?: boolean }, page: PageRequest) {
    const where = filter.active === undefined ? {} : { isActive: filter.active };
    const [items, total] = await Promise.all([
      this.db.coupon.findMany({ where, orderBy: { createdAt: 'desc' }, ...skipTake(page) }),
      this.db.coupon.count({ where }),
    ]);
    return { items, total };
  }

  setActive(id: string, isActive: boolean) {
    return this.db.coupon.update({ where: { id }, data: { isActive } });
  }
}
