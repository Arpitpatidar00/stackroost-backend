import type { Repositories, UnitOfWork } from '@/db/unitOfWork';
import {
  generateLicenseKey,
  isWellFormedLicenseKey,
  normalizeLicenseKey,
  previewLicenseKey,
} from '@/domain/licensing/licenseKey';
import type { LicenseTokenSigner } from '@/domain/licensing/licenseToken';
import type { EntitlementsService } from '@/modules/billing/entitlements.service';
import { addDays, type Clock } from '@/shared/clock';
import { sha256 } from '@/shared/crypto/tokens';
import { AppError } from '@/shared/errors/AppError';
import type { License } from '@/generated/prisma/client';

export interface LicenseConfig {
  tokenTtlDays: number;
  maxDevices: number;
  /** A token this long past its expiry can no longer be refreshed (must re-activate). */
  refreshWindowDays: number;
}

export interface DeviceInput {
  deviceId: string;
  deviceName: string;
  appVersion: string;
}

export interface IssuedToken {
  token: string;
  expiresAt: string;
  /** null = no active subscription: the app shows everything locked + "Subscribe". */
  plan: string | null;
  modules: readonly string[];
  features: readonly string[];
}

const invalid = () => new AppError('LICENSE_INVALID', 'That license key is not valid.', 403);

/** Same answer for unknown keys as for wrong ones: no key enumeration. */
function usable(license: License | null): License {
  if (!license) throw invalid();
  if (license.status === 'revoked') {
    throw new AppError('LICENSE_REVOKED', 'This license was revoked.', 403);
  }
  return license;
}

export class LicensesService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly entitlements: EntitlementsService,
    private readonly signer: LicenseTokenSigner,
    private readonly clock: Clock,
    private readonly config: LicenseConfig,
  ) {}

  /**
   * Issues the account's license once (idempotent) and queues the key email in
   * the same transaction. Called by billing when an account becomes entitled.
   */
  async ensureIssued(tx: Repositories, accountId: string, email: string): Promise<License> {
    const existing = await tx.licenses.findByAccount(accountId);
    if (existing) return existing;
    const key = generateLicenseKey();
    const license = await tx.licenses.create({
      accountId,
      keyHash: sha256(key),
      keyPreview: previewLicenseKey(key),
      maxDevices: this.config.maxDevices,
    });
    await tx.outbox.enqueue({ type: 'email.license_issued', payload: { email, licenseKey: key } });
    return license;
  }

  /** App: bind a Mac to the license and return a signed, offline-verifiable token. */
  activate(licenseKey: string, device: DeviceInput): Promise<IssuedToken> {
    const key = normalizeLicenseKey(licenseKey);
    if (!isWellFormedLicenseKey(key)) return Promise.reject(invalid());

    return this.uow.transaction(async (tx) => {
      const license = usable(await tx.licenses.findByKeyHash(sha256(key)));
      await tx.licenses.lockForUpdate(license.id);
      const already = await tx.activations.find(license.id, device.deviceId);
      if (!already && (await tx.activations.count(license.id)) >= license.maxDevices) {
        throw new AppError(
          'DEVICE_LIMIT_REACHED',
          `This license is active on ${license.maxDevices} Macs. Remove one at stackroost.dev/account.`,
          409,
          { maxDevices: license.maxDevices },
        );
      }
      await tx.activations.upsert({ licenseId: license.id, ...device, now: this.clock.now() });
      return this.issue(tx, license, device.deviceId);
    });
  }

  /** App: exchange a (possibly expired) token for a fresh one with the current plan. */
  async refresh(token: string, appVersion: string): Promise<IssuedToken> {
    const claims = this.signer.verify(token);
    if (!claims) throw invalid();
    const now = this.clock.now();
    if (now > addDays(new Date(claims.exp * 1000), this.config.refreshWindowDays)) {
      throw new AppError('LICENSE_INVALID', 'This activation expired. Activate again.', 403);
    }
    return this.uow.transaction(async (tx) => {
      const activation = await tx.activations.find(claims.sub, claims.dev);
      // Removed from the account page → this Mac must activate again.
      if (!activation) throw invalid();
      const license = usable(await tx.licenses.findById(claims.sub));
      await tx.activations.upsert({
        licenseId: license.id,
        deviceId: claims.dev,
        deviceName: activation.deviceName,
        appVersion,
        now,
      });
      return this.issue(tx, license, claims.dev);
    });
  }

  /** App: release this Mac's seat (sign-out / uninstall). Idempotent. */
  async deactivate(licenseKey: string, deviceId: string): Promise<void> {
    const key = normalizeLicenseKey(licenseKey);
    const license = await this.uow.repos.licenses.findByKeyHash(sha256(key));
    if (!license) throw invalid();
    await this.uow.repos.activations.deleteByDevice(license.id, deviceId);
  }

  /** Website: license summary + devices for the account page (never the key itself). */
  async overview(accountId: string) {
    const license = await this.uow.repos.licenses.findByAccount(accountId);
    if (!license) return null;
    const devices = await this.uow.repos.activations.list(license.id);
    return {
      keyPreview: license.keyPreview,
      status: license.status,
      maxDevices: license.maxDevices,
      devices: devices.map((d) => ({
        id: d.id,
        name: d.deviceName,
        appVersion: d.appVersion,
        lastSeenAt: d.lastSeenAt.toISOString(),
      })),
    };
  }

  /** Website: the account's activated Macs. */
  async listDevices(accountId: string) {
    const license = await this.uow.repos.licenses.findByAccount(accountId);
    return license ? this.uow.repos.activations.list(license.id) : [];
  }

  /** Website: free a seat. Scoped to the caller's own license (ownership check). */
  async removeDevice(accountId: string, activationId: string): Promise<void> {
    const license = await this.uow.repos.licenses.findByAccount(accountId);
    if (!license || !(await this.uow.repos.activations.delete(license.id, activationId))) {
      throw AppError.notFound('Device');
    }
  }

  /** Website: replace a leaked key. Returns the new key once; also emailed. */
  rotateKey(accountId: string, email: string): Promise<{ licenseKey: string; preview: string }> {
    return this.uow.transaction(async (tx) => {
      const license = await tx.licenses.findByAccount(accountId);
      if (!license) throw new AppError('NO_SUBSCRIPTION', 'You have no license yet.', 422);
      const key = generateLicenseKey();
      const preview = previewLicenseKey(key);
      await tx.licenses.rotateKey(license.id, sha256(key), preview);
      await tx.outbox.enqueue({
        type: 'email.license_key_rotated',
        payload: { email, licenseKey: key },
      });
      return { licenseKey: key, preview };
    });
  }

  /** Admin: revoke (blocks activation/refresh) or restore. */
  async setStatus(tx: Repositories, accountId: string, status: 'active' | 'revoked') {
    const license = await tx.licenses.findByAccount(accountId);
    if (!license) throw AppError.notFound('License');
    return tx.licenses.setStatus(license.id, status);
  }

  publicKeys() {
    return { keys: [this.signer.publicJwk()] };
  }

  private async issue(tx: Repositories, license: License, deviceId: string): Promise<IssuedToken> {
    const plan = await this.entitlements.planFor(tx, license.accountId);
    const now = this.clock.now();
    const exp = addDays(now, this.config.tokenTtlDays);
    const grant = {
      plan: plan?.key ?? null,
      modules: plan?.modules ?? [],
      features: plan?.features ?? [],
    };
    const token = this.signer.sign({
      sub: license.id,
      dev: deviceId,
      ...grant,
      iat: Math.floor(now.getTime() / 1000),
      exp: Math.floor(exp.getTime() / 1000),
    });
    return { token, expiresAt: exp.toISOString(), ...grant };
  }
}
