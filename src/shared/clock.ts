/** Injectable time source so expiry and grace logic is deterministic in tests. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export const addDays = (d: Date, days: number) => new Date(d.getTime() + days * 86_400_000);
export const addMinutes = (d: Date, minutes: number) => new Date(d.getTime() + minutes * 60_000);
