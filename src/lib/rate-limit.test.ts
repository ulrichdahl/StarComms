import { describe, expect, it } from 'vitest';
import { RateLimitError } from 'discord.js';
import { isRateLimitError, rejectChannelPatchRateLimit } from './rate-limit.js';

const data = (over: Partial<ConstructorParameters<typeof RateLimitError>[0]> = {}) => ({
  timeToReset: 600_000, limit: 2, method: 'PATCH', hash: 'h', url: 'u',
  route: '/channels/:id', majorParameter: '1', global: false, retryAfter: 600_000,
  sublimitTimeout: 600_000, scope: 'shared' as const, ...over,
});

describe('rejectChannelPatchRateLimit', () => {
  it('rejects only PATCH /channels/:id', () => {
    expect(rejectChannelPatchRateLimit(data())).toBe(true);
    expect(rejectChannelPatchRateLimit(data({ method: 'POST' }))).toBe(false);
    expect(rejectChannelPatchRateLimit(data({ route: '/channels/:id/messages' }))).toBe(false);
    expect(rejectChannelPatchRateLimit(data({ route: '/guilds/:id/members/:id' }))).toBe(false);
  });
});

describe('isRateLimitError', () => {
  it('recognises RateLimitError, 429 codes and rate-limit messages', () => {
    expect(isRateLimitError(new RateLimitError(data()))).toBe(true);
    expect(isRateLimitError(Object.assign(new Error('x'), { code: 429 }))).toBe(true);
    expect(isRateLimitError(new Error('You are being rate limited.'))).toBe(true);
    expect(isRateLimitError(new Error('Missing Permissions'))).toBe(false);
    expect(isRateLimitError('nope')).toBe(false);
  });
});
