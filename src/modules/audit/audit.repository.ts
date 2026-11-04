import type { AuditLog, Prisma } from '@/generated/prisma/client';
import type { DbClient } from '@/db/prisma';
import { skipTake, type Page, type PageRequest } from '@/shared/http/pagination';

export interface AuditEntry {
  actorId: string;
  action: string;
  targetType: string;
  targetId: string;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

export interface AuditRepository {
  record(entry: AuditEntry): Promise<void>;
  list(
    filter: { actorId?: string; targetType?: string; targetId?: string },
    page: PageRequest,
  ): Promise<Page<AuditLog>>;
}

export class PrismaAuditRepository implements AuditRepository {
  constructor(private readonly db: DbClient) {}

  async record(entry: AuditEntry) {
    await this.db.auditLog.create({
      data: { ...entry, metadata: (entry.metadata ?? {}) as Prisma.InputJsonValue },
    });
  }

  async list(
    filter: { actorId?: string; targetType?: string; targetId?: string },
    page: PageRequest,
  ) {
    const [items, total] = await Promise.all([
      this.db.auditLog.findMany({
        where: filter,
        orderBy: { createdAt: 'desc' },
        ...skipTake(page),
      }),
      this.db.auditLog.count({ where: filter }),
    ]);
    return { items, total };
  }
}
