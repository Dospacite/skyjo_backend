import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const TokenPayloadSchema = z.object({
  v: z.literal(1),
  roomCode: z.string(),
  playerId: z.string(),
  seatIndex: z.number().int().min(0),
  iat: z.number().int().nonnegative(),
});

export type PlayerTokenPayload = z.infer<typeof TokenPayloadSchema>;

function b64urlEncode(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function b64urlDecode(input: string): Buffer {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4 || 4)) % 4);
  return Buffer.from(padded, 'base64');
}

export function signPlayerToken(payload: Omit<PlayerTokenPayload, 'v' | 'iat'>, secret: string, now = Date.now()): string {
  const body = {
    v: 1 as const,
    iat: Math.floor(now / 1000),
    ...payload,
  };
  const encoded = b64urlEncode(JSON.stringify(body));
  const sig = b64urlEncode(createHmac('sha256', secret).update(encoded).digest());
  return `${encoded}.${sig}`;
}

export function verifyPlayerToken(token: string, secret: string): PlayerTokenPayload {
  const [encoded, sig] = token.split('.');
  if (!encoded || !sig) {
    throw new Error('Malformed token');
  }
  const expected = createHmac('sha256', secret).update(encoded).digest();
  const actual = b64urlDecode(sig);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error('Invalid token signature');
  }
  const parsed = JSON.parse(b64urlDecode(encoded).toString('utf8'));
  return TokenPayloadSchema.parse(parsed);
}
