import type { Request, Response } from 'express';
import { principal } from '@/middleware/auth';
import type { CheckoutService } from '@/modules/checkout/checkout.service';
import { AppError } from '@/shared/errors/AppError';
import { noContent, ok } from '@/shared/http/response';
import { input } from '@/shared/http/validate';
import type { BillingService } from './billing.service';
import { checkoutSchema, couponPreviewSchema, planChangeSchema } from './billing.validation';
import type { SubscriptionsService } from './subscriptions.service';

export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly checkout: CheckoutService,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  /** Paddle webhook. Body is the RAW buffer (the signature covers exact bytes). */
  paddleWebhook = async (req: Request, res: Response) => {
    const signature = req.header('paddle-signature') ?? '';
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    if (!signature || !rawBody)
      throw new AppError('WEBHOOK_REJECTED', 'Missing signature or body.', 400);
    // 2xx only after the transaction committed; any throw → non-2xx → Paddle retries.
    ok(res, { outcome: await this.billing.handleWebhook(rawBody, signature) });
  };

  startCheckout = async (req: Request, res: Response) => {
    const { body } = input(req, checkoutSchema);
    const { accountId, email } = principal(req);
    ok(res, await this.checkout.start({ accountId, email, name: null }, body), 201);
  };

  previewCoupon = async (req: Request, res: Response) => {
    const { body } = input(req, couponPreviewSchema);
    ok(res, await this.checkout.previewCoupon(body.code, body.priceId));
  };

  previewChange = async (req: Request, res: Response) => {
    const { body } = input(req, planChangeSchema);
    ok(res, await this.subscriptions.preview(principal(req).accountId, body.priceId));
  };

  changePlan = async (req: Request, res: Response) => {
    const { body } = input(req, planChangeSchema);
    ok(res, await this.subscriptions.change(principal(req).accountId, body.priceId));
  };

  cancelScheduledChange = async (req: Request, res: Response) => {
    await this.subscriptions.cancelScheduledChange(principal(req).accountId);
    noContent(res);
  };

  portal = async (req: Request, res: Response) => {
    ok(res, { url: await this.billing.portalUrl(principal(req).accountId) });
  };
}
