import { z } from 'zod';

export const startGoogleSchema = {
  query: z.object({ returnTo: z.string().max(512).optional() }),
};

export const googleCallbackSchema = {
  query: z.union([
    z.object({ code: z.string().min(1).max(2048), state: z.string().min(1).max(256) }),
    // The user pressed "Cancel" on Google's screen.
    z.object({ error: z.string().max(128), state: z.string().max(256).optional() }),
  ]),
};
