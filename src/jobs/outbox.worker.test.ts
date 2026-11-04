import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import type { Email } from '@/integrations/mailer/mailer';
import { TestClock } from '../../test/fakes/harness';
import { MemoryUnitOfWork } from '../../test/fakes/memory';
import { OutboxWorker } from './outbox.worker';

const setup = (fail = false) => {
  const clock = new TestClock();
  const uow = new MemoryUnitOfWork(() => clock.now());
  const sent: Email[] = [];
  const mailer = {
    send: (e: Email) =>
      fail ? Promise.reject(new Error('smtp down')) : (sent.push(e), Promise.resolve()),
  };
  return {
    uow,
    sent,
    clock,
    worker: new OutboxWorker(uow, mailer, clock, pino({ level: 'silent' })),
  };
};
const message = {
  type: 'email.license_issued' as const,
  payload: { email: 'a@b.co', licenseKey: 'SR-X' },
};

describe('OutboxWorker', () => {
  it('delivers pending jobs once', async () => {
    const { uow, sent, worker } = setup();
    await uow.repos.outbox.enqueue(message);
    expect(await worker.runOnce()).toBe(1);
    expect(await worker.runOnce()).toBe(0);
    expect(sent).toEqual([
      expect.objectContaining({ to: 'a@b.co', subject: 'Your Stackroost license' }),
    ]);
  });

  it('backs off on failure instead of hammering the provider', async () => {
    const { uow, worker, clock } = setup(true);
    await uow.repos.outbox.enqueue(message);
    await worker.runOnce();
    const [job] = [...uow.state.outbox.values()];
    expect(job).toMatchObject({ status: 'pending', lastError: 'smtp down' });
    expect(job!.runAfter > clock.now()).toBe(true);
    expect(await worker.runOnce()).toBe(0);
  });
});
