import { randomUUID } from 'node:crypto';
import type { Repositories, UnitOfWork } from '@/db/unitOfWork';
import type {
  Account,
  Activation,
  AuditLog,
  Coupon,
  Customer,
  License,
  OutboxJob,
  Plan,
  PlanPrice,
  Session,
  Subscription,
} from '@/generated/prisma/client';
import type { OutboxMessage } from '@/jobs/outbox.messages';
import type { PageRequest } from '@/shared/http/pagination';

/** All persisted state, as plain maps — cloned to give transactions rollback. */
interface State {
  accounts: Map<string, Account>;
  sessions: Map<string, Session>;
  plans: Map<string, Plan>;
  prices: Map<string, PlanPrice>;
  coupons: Map<string, Coupon>;
  customers: Map<string, Customer>;
  subscriptions: Map<string, Subscription>;
  webhookEvents: Set<string>;
  licenses: Map<string, License>;
  activations: Map<string, Activation>;
  outbox: Map<string, OutboxJob>;
  audit: AuditLog[];
}

const emptyState = (): State => ({
  accounts: new Map(),
  sessions: new Map(),
  plans: new Map(),
  prices: new Map(),
  coupons: new Map(),
  customers: new Map(),
  subscriptions: new Map(),
  webhookEvents: new Set(),
  licenses: new Map(),
  activations: new Map(),
  outbox: new Map(),
  audit: [],
});

const id = () => randomUUID();
const page = <T>(items: T[], p: PageRequest) => ({
  items: items.slice((p.page - 1) * p.limit, p.page * p.limit),
  total: items.length,
});
/** Mirrors Postgres unique constraints (Prisma error P2002). */
const unique = (violated: boolean) => {
  if (violated) throw Object.assign(new Error('unique violation'), { code: 'P2002' });
};
const contains = (v: string | null | undefined, q: string) =>
  !!v?.toLowerCase().includes(q.toLowerCase());

function repositories(s: () => State, now: () => Date): Repositories {
  const values = <T>(m: Map<string, T>) => [...m.values()];
  const customerIdsOf = (accountId: string) =>
    new Set(
      values(s().customers)
        .filter((c) => c.accountId === accountId)
        .map((c) => c.id),
    );
  const withAccount = (sub: Subscription) => {
    const customer = s().customers.get(sub.customerId)!;
    const account = customer.accountId ? (s().accounts.get(customer.accountId) ?? null) : null;
    return { ...sub, customer: { ...customer, account } };
  };
  const withPrices = (plan: Plan, activeOnly = false) => ({
    ...plan,
    prices: values(s().prices)
      .filter((p) => p.planId === plan.id && (!activeOnly || p.isActive))
      .sort((a, b) => a.amountMinor - b.amountMinor),
  });

  return {
    accounts: {
      findById: async (aid) => s().accounts.get(aid) ?? null,
      findByEmail: async (email) => values(s().accounts).find((a) => a.email === email) ?? null,
      async upsertByEmail(email) {
        const found = values(s().accounts).find((a) => a.email === email);
        if (found) return found;
        const a: Account = {
          id: id(),
          email,
          googleSub: null,
          name: null,
          role: 'user',
          lastLoginAt: null,
          createdAt: now(),
          updatedAt: now(),
        };
        s().accounts.set(a.id, a);
        return a;
      },
      async upsertGoogleIdentity({ googleSub, email, name, promoteToAdmin, now: at }) {
        const existing =
          values(s().accounts).find((a) => a.googleSub === googleSub) ??
          values(s().accounts).find((a) => a.email === email);
        const a: Account = {
          id: existing?.id ?? id(),
          email,
          googleSub,
          name,
          role: promoteToAdmin ? 'admin' : (existing?.role ?? 'user'),
          lastLoginAt: at,
          createdAt: existing?.createdAt ?? at,
          updatedAt: at,
        };
        s().accounts.set(a.id, a);
        return a;
      },
      async list(filter, p) {
        const items = values(s().accounts)
          .filter(
            (a) =>
              (!filter.role || a.role === filter.role) &&
              (!filter.search ||
                contains(a.email, filter.search) ||
                contains(a.name, filter.search)),
          )
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return page(items, p);
      },
      async setRole(aid, role) {
        const a = { ...s().accounts.get(aid)!, role };
        s().accounts.set(aid, a);
        return a;
      },
    },
    auth: {
      async createSession({ tokenHash, accountId, expiresAt, now: at }) {
        const x: Session = {
          id: id(),
          tokenHash,
          accountId,
          expiresAt,
          lastUsedAt: at,
          createdAt: at,
        };
        s().sessions.set(x.id, x);
        return x;
      },
      async findActiveSession(tokenHash, at, idleCutoff) {
        const x = values(s().sessions).find(
          (v) => v.tokenHash === tokenHash && v.expiresAt > at && v.lastUsedAt > idleCutoff,
        );
        const account = x && s().accounts.get(x.accountId);
        return x && account ? { ...x, account } : null;
      },
      async touch(sid, at) {
        const x = s().sessions.get(sid);
        if (x) s().sessions.set(sid, { ...x, lastUsedAt: at });
      },
      async deleteSession(sid) {
        s().sessions.delete(sid);
      },
      async deleteAccountSessions(accountId) {
        const ids = values(s().sessions)
          .filter((x) => x.accountId === accountId)
          .map((x) => x.id);
        for (const sid of ids) s().sessions.delete(sid);
        return ids.length;
      },
      async purgeExpired(at, idleCutoff) {
        const ids = values(s().sessions)
          .filter((x) => x.expiresAt <= at || x.lastUsedAt <= idleCutoff)
          .map((x) => x.id);
        for (const sid of ids) s().sessions.delete(sid);
        return ids.length;
      },
    },
    audit: {
      async record(entry) {
        s().audit.push({
          id: id(),
          createdAt: now(),
          actorId: entry.actorId,
          action: entry.action,
          targetType: entry.targetType,
          targetId: entry.targetId,
          metadata: (entry.metadata ?? {}) as AuditLog['metadata'],
          ip: entry.ip ?? null,
        });
      },
      async list(filter, p) {
        const items = [...s().audit]
          .reverse()
          .filter(
            (e) =>
              (!filter.actorId || e.actorId === filter.actorId) &&
              (!filter.targetType || e.targetType === filter.targetType) &&
              (!filter.targetId || e.targetId === filter.targetId),
          );
        return page(items, p);
      },
    },
    catalog: {
      async listPlans({ activeOnly }) {
        return values(s().plans)
          .filter((p) => !activeOnly || p.isActive)
          .sort((a, b) => a.rank - b.rank)
          .map((p) => withPrices(p, activeOnly));
      },
      findPlanById: async (pid) => {
        const p = s().plans.get(pid);
        return p ? withPrices(p) : null;
      },
      findPlanByKey: async (key) => values(s().plans).find((p) => p.key === key) ?? null,
      findPlanByRank: async (rank) => values(s().plans).find((p) => p.rank === rank) ?? null,
      async createPlan(input) {
        unique(values(s().plans).some((p) => p.key === input.key || p.rank === input.rank));
        const p: Plan = {
          id: id(),
          isActive: true,
          paddleProductId: null,
          createdAt: now(),
          updatedAt: now(),
          ...input,
        };
        s().plans.set(p.id, p);
        return p;
      },
      async updatePlan(pid, input) {
        unique(
          input.rank !== undefined &&
            values(s().plans).some((p) => p.id !== pid && p.rank === input.rank),
        );
        const p: Plan = { ...s().plans.get(pid)!, ...input, updatedAt: now() };
        s().plans.set(pid, p);
        return p;
      },
      async setPlanProduct(pid, paddleProductId) {
        s().plans.set(pid, { ...s().plans.get(pid)!, paddleProductId });
      },
      findPriceById: async (pid) => s().prices.get(pid) ?? null,
      findPriceByPaddleId: async (paddlePriceId) => {
        const price = values(s().prices).find((p) => p.paddlePriceId === paddlePriceId);
        return price ? { ...price, plan: s().plans.get(price.planId)! } : null;
      },
      async createPrice(input) {
        unique(values(s().prices).some((p) => p.paddlePriceId === input.paddlePriceId));
        const p: PlanPrice = {
          id: id(),
          isActive: true,
          createdAt: now(),
          updatedAt: now(),
          ...input,
        };
        s().prices.set(p.id, p);
        return p;
      },
      async setPriceActive(pid, isActive) {
        const p = { ...s().prices.get(pid)!, isActive };
        s().prices.set(pid, p);
        return p;
      },
    },
    coupons: {
      async create(input) {
        unique(values(s().coupons).some((c) => c.code === input.code));
        const c: Coupon = {
          id: id(),
          isActive: true,
          createdAt: now(),
          updatedAt: now(),
          ...input,
        };
        s().coupons.set(c.id, c);
        return c;
      },
      findById: async (cid) => s().coupons.get(cid) ?? null,
      findByCode: async (code) => values(s().coupons).find((c) => c.code === code) ?? null,
      list: async (filter, p) =>
        page(
          values(s().coupons).filter(
            (c) => filter.active === undefined || c.isActive === filter.active,
          ),
          p,
        ),
      async setActive(cid, isActive) {
        const c = { ...s().coupons.get(cid)!, isActive };
        s().coupons.set(cid, c);
        return c;
      },
    },
    customers: {
      findById: async (cid) => s().customers.get(cid) ?? null,
      async upsert({ id: cid, email, accountId }) {
        const prev = s().customers.get(cid);
        const c: Customer = {
          id: cid,
          email: email !== undefined ? email : (prev?.email ?? null),
          accountId: accountId !== undefined ? accountId : (prev?.accountId ?? null),
          createdAt: prev?.createdAt ?? now(),
          updatedAt: now(),
        };
        s().customers.set(cid, c);
        return c;
      },
      listByAccount: async (accountId) =>
        values(s().customers).filter((c) => c.accountId === accountId),
    },
    subscriptions: {
      async upsertIfNewer(data) {
        const prev = s().subscriptions.get(data.id);
        if (prev && prev.lastEventAt > data.lastEventAt) return false;
        // Like Prisma's update: fields absent from `data` (pending/grace) are kept.
        s().subscriptions.set(data.id, {
          pendingPriceId: null,
          pendingRequestedAt: null,
          graceFromPriceId: null,
          graceUntil: null,
          ...prev,
          ...data,
          createdAt: prev?.createdAt ?? now(),
          updatedAt: now(),
        });
        return true;
      },
      listByAccount: async (accountId) => {
        const ids = customerIdsOf(accountId);
        return values(s().subscriptions).filter((x) => ids.has(x.customerId));
      },
      findById: async (sid) => {
        const sub = s().subscriptions.get(sid);
        return sub ? withAccount(sub) : null;
      },
      async setPending(sid, priceId, at) {
        s().subscriptions.set(sid, {
          ...s().subscriptions.get(sid)!,
          pendingPriceId: priceId,
          pendingRequestedAt: priceId ? at : null,
        });
      },
      dueDowngrades: async (before) =>
        values(s().subscriptions).filter(
          (x) =>
            x.pendingPriceId &&
            x.status === 'active' &&
            x.currentPeriodEndsAt &&
            x.currentPeriodEndsAt <= before,
        ),
      async markDowngradeApplied(sid, graceFromPriceId, graceUntil) {
        s().subscriptions.set(sid, {
          ...s().subscriptions.get(sid)!,
          pendingPriceId: null,
          pendingRequestedAt: null,
          graceFromPriceId,
          graceUntil,
        });
      },
      adminList: async (filter, p) => {
        const items = values(s().subscriptions)
          .map(withAccount)
          .filter(
            (x) =>
              (!filter.status || x.status === filter.status) &&
              (!filter.search ||
                contains(x.customer.email, filter.search) ||
                contains(x.customer.account?.email, filter.search)),
          );
        return page(items, p);
      },
      countByStatusAndPrice: async () => {
        const rows = new Map<
          string,
          { status: Subscription['status']; priceId: string; count: number }
        >();
        for (const x of values(s().subscriptions)) {
          const key = `${x.status}|${x.priceId}`;
          const row = rows.get(key) ?? { status: x.status, priceId: x.priceId, count: 0 };
          row.count++;
          rows.set(key, row);
        }
        return [...rows.values()];
      },
    },
    webhookEvents: {
      async tryRecord(e) {
        if (s().webhookEvents.has(e.id)) return false;
        s().webhookEvents.add(e.id);
        return true;
      },
    },
    licenses: {
      findById: async (lid) => s().licenses.get(lid) ?? null,
      findByAccount: async (accountId) =>
        values(s().licenses).find((l) => l.accountId === accountId) ?? null,
      findByKeyHash: async (keyHash) =>
        values(s().licenses).find((l) => l.keyHash === keyHash) ?? null,
      async create(data) {
        const l: License = {
          id: id(),
          status: 'active',
          createdAt: now(),
          updatedAt: now(),
          ...data,
        };
        s().licenses.set(l.id, l);
        return l;
      },
      async rotateKey(lid, keyHash, keyPreview) {
        const l = { ...s().licenses.get(lid)!, keyHash, keyPreview, updatedAt: now() };
        s().licenses.set(lid, l);
        return l;
      },
      async setStatus(lid, status) {
        const l = { ...s().licenses.get(lid)!, status };
        s().licenses.set(lid, l);
        return l;
      },
      lockForUpdate: async () => undefined,
    },
    activations: {
      find: async (licenseId, deviceId) =>
        values(s().activations).find((a) => a.licenseId === licenseId && a.deviceId === deviceId) ??
        null,
      count: async (licenseId) =>
        values(s().activations).filter((a) => a.licenseId === licenseId).length,
      list: async (licenseId) => values(s().activations).filter((a) => a.licenseId === licenseId),
      async upsert({ licenseId, deviceId, deviceName, appVersion, now: at }) {
        const prev = values(s().activations).find(
          (a) => a.licenseId === licenseId && a.deviceId === deviceId,
        );
        const a: Activation = {
          id: prev?.id ?? id(),
          licenseId,
          deviceId,
          deviceName,
          appVersion,
          lastSeenAt: at,
          createdAt: prev?.createdAt ?? at,
        };
        s().activations.set(a.id, a);
        return a;
      },
      async delete(licenseId, activationId) {
        const a = s().activations.get(activationId);
        if (a?.licenseId !== licenseId) return false;
        return s().activations.delete(activationId);
      },
      async deleteByDevice(licenseId, deviceId) {
        const a = values(s().activations).find(
          (x) => x.licenseId === licenseId && x.deviceId === deviceId,
        );
        return a ? s().activations.delete(a.id) : false;
      },
    },
    outbox: {
      async enqueue(message: OutboxMessage) {
        const j: OutboxJob = {
          id: id(),
          type: message.type,
          payload: message.payload,
          status: 'pending',
          attempts: 0,
          runAfter: now(),
          lastError: null,
          createdAt: now(),
          updatedAt: now(),
        };
        s().outbox.set(j.id, j);
      },
      async claimDue(limit, at) {
        const due = values(s().outbox)
          .filter((j) => j.status === 'pending' && j.runAfter <= at)
          .slice(0, limit)
          .map((j) => ({ ...j, attempts: j.attempts + 1 }));
        for (const j of due) s().outbox.set(j.id, j);
        return due;
      },
      async markDone(jid) {
        s().outbox.set(jid, { ...s().outbox.get(jid)!, status: 'done' });
      },
      async markFailed(jid, error, retryAt) {
        const j = s().outbox.get(jid)!;
        s().outbox.set(
          jid,
          retryAt
            ? { ...j, lastError: error, runAfter: retryAt }
            : { ...j, lastError: error, status: 'failed' },
        );
      },
    },
  };
}

/** In-memory Unit of Work with real rollback semantics (snapshot + restore). */
export class MemoryUnitOfWork implements UnitOfWork {
  state: State = emptyState();
  readonly repos: Repositories;

  /** `now` stamps createdAt/runAfter — pass the test clock for determinism. */
  constructor(now: () => Date = () => new Date()) {
    this.repos = repositories(() => this.state, now);
  }

  async transaction<T>(work: (tx: Repositories) => Promise<T>): Promise<T> {
    const snapshot = structuredClone(this.state);
    try {
      return await work(this.repos);
    } catch (e) {
      this.state = snapshot;
      throw e;
    }
  }

  /** Test helper: outbox messages of one type. */
  outboxOf<T extends OutboxMessage['type']>(type: T) {
    return [...this.state.outbox.values()]
      .filter((j) => j.type === type)
      .map((j) => j.payload as Extract<OutboxMessage, { type: T }>['payload']);
  }
}
