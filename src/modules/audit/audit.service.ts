import type { Repositories, UnitOfWork } from '@/db/unitOfWork';
import type { PageRequest } from '@/shared/http/pagination';

/** Who performed an admin action, and from where. */
export interface Actor {
  accountId: string;
  ip: string | null;
}

/** Append-only trail of admin actions. Written in the same transaction as the change. */
export class AuditService {
  constructor(private readonly uow: UnitOfWork) {}

  record(
    tx: Repositories,
    actor: Actor,
    action: string,
    target: { type: string; id: string },
    metadata: Record<string, unknown> = {},
  ) {
    return tx.audit.record({
      actorId: actor.accountId,
      action,
      targetType: target.type,
      targetId: target.id,
      metadata,
      ip: actor.ip,
    });
  }

  list(filter: { actorId?: string; targetType?: string; targetId?: string }, page: PageRequest) {
    return this.uow.repos.audit.list(filter, page);
  }
}
