import type { Activation, License, LicenseStatus } from '@/generated/prisma/client';
import type { DbClient } from '@/db/prisma';

export interface ActivationUpsert {
  licenseId: string;
  deviceId: string;
  deviceName: string;
  appVersion: string;
  now: Date;
}

export interface LicensesRepository {
  findById(id: string): Promise<License | null>;
  findByAccount(accountId: string): Promise<License | null>;
  findByKeyHash(keyHash: string): Promise<License | null>;
  create(data: {
    accountId: string;
    keyHash: string;
    keyPreview: string;
    maxDevices: number;
  }): Promise<License>;
  rotateKey(id: string, keyHash: string, keyPreview: string): Promise<License>;
  setStatus(id: string, status: LicenseStatus): Promise<License>;
  /** Row lock for the rest of the transaction: serialises device-limit checks. */
  lockForUpdate(id: string): Promise<void>;
}

export interface ActivationsRepository {
  find(licenseId: string, deviceId: string): Promise<Activation | null>;
  count(licenseId: string): Promise<number>;
  list(licenseId: string): Promise<Activation[]>;
  upsert(data: ActivationUpsert): Promise<Activation>;
  /** Deletes by activation id, scoped to the license (ownership). */
  delete(licenseId: string, activationId: string): Promise<boolean>;
  deleteByDevice(licenseId: string, deviceId: string): Promise<boolean>;
}

export class PrismaLicensesRepository implements LicensesRepository {
  constructor(private readonly db: DbClient) {}

  findById(id: string) {
    return this.db.license.findUnique({ where: { id } });
  }

  findByAccount(accountId: string) {
    return this.db.license.findUnique({ where: { accountId } });
  }

  findByKeyHash(keyHash: string) {
    return this.db.license.findUnique({ where: { keyHash } });
  }

  create(data: { accountId: string; keyHash: string; keyPreview: string; maxDevices: number }) {
    return this.db.license.create({ data });
  }

  rotateKey(id: string, keyHash: string, keyPreview: string) {
    return this.db.license.update({ where: { id }, data: { keyHash, keyPreview } });
  }

  setStatus(id: string, status: LicenseStatus) {
    return this.db.license.update({ where: { id }, data: { status } });
  }

  async lockForUpdate(id: string) {
    await this.db.$queryRaw`SELECT 1 FROM "licenses" WHERE "id" = ${id} FOR UPDATE`;
  }
}

export class PrismaActivationsRepository implements ActivationsRepository {
  constructor(private readonly db: DbClient) {}

  find(licenseId: string, deviceId: string) {
    return this.db.activation.findUnique({
      where: { licenseId_deviceId: { licenseId, deviceId } },
    });
  }

  count(licenseId: string) {
    return this.db.activation.count({ where: { licenseId } });
  }

  list(licenseId: string) {
    return this.db.activation.findMany({ where: { licenseId }, orderBy: { lastSeenAt: 'desc' } });
  }

  upsert({ licenseId, deviceId, deviceName, appVersion, now }: ActivationUpsert) {
    return this.db.activation.upsert({
      where: { licenseId_deviceId: { licenseId, deviceId } },
      create: { licenseId, deviceId, deviceName, appVersion, lastSeenAt: now },
      update: { deviceName, appVersion, lastSeenAt: now },
    });
  }

  async delete(licenseId: string, activationId: string) {
    const { count } = await this.db.activation.deleteMany({
      where: { id: activationId, licenseId },
    });
    return count > 0;
  }

  async deleteByDevice(licenseId: string, deviceId: string) {
    const { count } = await this.db.activation.deleteMany({ where: { licenseId, deviceId } });
    return count > 0;
  }
}
