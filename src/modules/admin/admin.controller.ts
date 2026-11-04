import type { Request, Response } from 'express';
import { actorOf } from '@/middleware/auth';
import type { AuditService } from '@/modules/audit/audit.service';
import type { CatalogService } from '@/modules/catalog/catalog.service';
import type { CouponsService } from '@/modules/coupons/coupons.service';
import { noContent, ok } from '@/shared/http/response';
import { pageMeta } from '@/shared/http/pagination';
import { input } from '@/shared/http/validate';
import type { AdminAccountsService } from './adminAccounts.service';
import type { AdminInsightsService } from './adminInsights.service';
import type { AdminSubscriptionsService } from './adminSubscriptions.service';
import * as s from './admin.validation';

/** Thin HTTP adapter over the admin services. Every write passes the actor for the audit log. */
export class AdminController {
  constructor(
    private readonly accounts: AdminAccountsService,
    private readonly subscriptions: AdminSubscriptionsService,
    private readonly insights: AdminInsightsService,
    private readonly catalog: CatalogService,
    private readonly coupons: CouponsService,
    private readonly audit: AuditService,
  ) {}

  stats = async (_req: Request, res: Response) => {
    ok(res, await this.insights.overview());
  };

  // ---- accounts ----
  listAccounts = async (req: Request, res: Response) => {
    const { query } = input(req, s.listAccountsSchema);
    const { items, total } = await this.accounts.list(query, query);
    ok(res, items, 200, pageMeta(query, total));
  };
  account = async (req: Request, res: Response) => {
    ok(res, await this.accounts.detail(input(req, s.accountIdSchema).params.id));
  };
  setRole = async (req: Request, res: Response) => {
    const { params, body } = input(req, s.setRoleSchema);
    ok(res, await this.accounts.setRole(actorOf(req), params.id, body.role));
  };
  revokeLicense = async (req: Request, res: Response) => {
    ok(
      res,
      await this.accounts.setLicenseStatus(
        actorOf(req),
        input(req, s.accountIdSchema).params.id,
        'revoked',
      ),
    );
  };
  restoreLicense = async (req: Request, res: Response) => {
    ok(
      res,
      await this.accounts.setLicenseStatus(
        actorOf(req),
        input(req, s.accountIdSchema).params.id,
        'active',
      ),
    );
  };
  revokeSessions = async (req: Request, res: Response) => {
    ok(
      res,
      await this.accounts.revokeSessions(actorOf(req), input(req, s.accountIdSchema).params.id),
    );
  };

  // ---- plans & prices ----
  listPlans = async (_req: Request, res: Response) => {
    ok(res, await this.catalog.listPlans());
  };
  createPlan = async (req: Request, res: Response) => {
    ok(res, await this.catalog.createPlan(actorOf(req), input(req, s.createPlanSchema).body), 201);
  };
  updatePlan = async (req: Request, res: Response) => {
    const { params, body } = input(req, s.updatePlanSchema);
    ok(res, await this.catalog.updatePlan(actorOf(req), params.id, body));
  };
  createPrice = async (req: Request, res: Response) => {
    const { params, body } = input(req, s.createPriceSchema);
    ok(res, await this.catalog.createPrice(actorOf(req), params.id, body), 201);
  };
  setPriceActive = async (req: Request, res: Response) => {
    const { params, body } = input(req, s.setActiveSchema);
    ok(res, await this.catalog.setPriceActive(actorOf(req), params.id, body.isActive));
  };

  // ---- coupons ----
  listCoupons = async (req: Request, res: Response) => {
    const { query } = input(req, s.listCouponsSchema);
    const { items, total } = await this.coupons.list({ active: query.active }, query);
    ok(res, items, 200, pageMeta(query, total));
  };
  createCoupon = async (req: Request, res: Response) => {
    ok(res, await this.coupons.create(actorOf(req), input(req, s.createCouponSchema).body), 201);
  };
  setCouponActive = async (req: Request, res: Response) => {
    const { params, body } = input(req, s.setActiveSchema);
    ok(res, await this.coupons.setActive(actorOf(req), params.id, body.isActive));
  };

  // ---- subscriptions ----
  listSubscriptions = async (req: Request, res: Response) => {
    const { query } = input(req, s.listSubscriptionsSchema);
    const { items, total } = await this.subscriptions.list(query, query);
    ok(res, items, 200, pageMeta(query, total));
  };
  subscription = async (req: Request, res: Response) => {
    ok(res, await this.subscriptions.detail(input(req, s.subscriptionIdSchema).params.id));
  };
  cancelSubscription = async (req: Request, res: Response) => {
    const { params, body } = input(req, s.subscriptionActionSchema);
    await this.subscriptions.cancel(actorOf(req), params.id, body.effectiveFrom);
    noContent(res);
  };
  pauseSubscription = async (req: Request, res: Response) => {
    const { params, body } = input(req, s.subscriptionActionSchema);
    await this.subscriptions.pause(actorOf(req), params.id, body.effectiveFrom);
    noContent(res);
  };
  resumeSubscription = async (req: Request, res: Response) => {
    await this.subscriptions.resume(actorOf(req), input(req, s.subscriptionIdSchema).params.id);
    noContent(res);
  };

  // ---- audit ----
  auditLog = async (req: Request, res: Response) => {
    const { query } = input(req, s.auditLogSchema);
    const { page, limit, ...filter } = query;
    const { items, total } = await this.audit.list(filter, { page, limit });
    ok(res, items, 200, pageMeta({ page, limit }, total));
  };
}
