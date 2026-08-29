/**
 * Discord rate-limit detection for the channel-rename gate.
 *
 * `@discordjs/rest` defaults to `rejectOnRateLimit: null`, which means a
 * 429 is *queued*: the request promise simply waits — for a channel-name
 * PATCH that is up to 10 minutes. Nothing downstream can "abort on rate
 * limit" under that default, so the fleet's Clients are built with
 * `rejectChannelPatchRateLimit`, which turns a 429 on `PATCH
 * /channels/:id` (and only that) into a thrown `RateLimitError`. Every
 * other route keeps the queue-and-wait default, so message sends and
 * member moves are unaffected.
 */

import { RateLimitError, type RateLimitData } from 'discord.js';

/** REST option: reject (throw) instead of waiting when a channel edit is rate-limited. */
export function rejectChannelPatchRateLimit(data: RateLimitData): boolean {
  return data.method.toUpperCase() === 'PATCH' && data.route === '/channels/:id';
}

/** True for a rejected rate limit from the REST layer, or a raw 429 shape. */
export function isRateLimitError(err: unknown): boolean {
  if (err instanceof RateLimitError) return true;
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown; status?: unknown }).code ?? (err as { status?: unknown }).status;
  if (code === 429) return true;
  return /rate ?limit/i.test(err.message);
}
