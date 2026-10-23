import crypto from 'crypto';
import { config } from '../config/environment';

/**
 * MCP refresh tokens are sealed (AES-256-GCM) rather than looked up, so a session can be
 * rebuilt after a restart: the token carries the user's current Tanda tokens. The key is
 * derived from SESSION_SECRET, so rotating that secret signs everyone out.
 */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PREFIX = 'rt1.';

export interface RefreshClaims {
  /** Session id the token was issued for */
  sid: string;
  /** Tanda user id */
  uid: number;
  /** Tanda access token, refresh token and its expiry (ms since epoch) at issue time */
  at: string;
  rt?: string;
  atExp?: number;
  /** Unique id, so a used token can be refused */
  jti: string;
  /** Expiry (ms since epoch) */
  exp: number;
}

function key(): Buffer {
  return crypto.createHash('sha256').update(`mcp-refresh-token:${config.SESSION_SECRET}`).digest();
}

export function sealRefreshToken(claims: Omit<RefreshClaims, 'jti' | 'exp'>, now = Date.now()): string {
  const body: RefreshClaims = { ...claims, jti: crypto.randomUUID(), exp: now + REFRESH_TOKEN_TTL_MS };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const sealed = Buffer.concat([cipher.update(JSON.stringify(body), 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString('base64url');
}

/** Returns the claims, or null if the token is malformed, tampered with, or expired. */
export function openRefreshToken(token: unknown, now = Date.now()): RefreshClaims | null {
  if (typeof token !== 'string' || !token.startsWith(PREFIX)) return null;
  try {
    const raw = Buffer.from(token.slice(PREFIX.length), 'base64url');
    if (raw.length < 29) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const claims = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')) as RefreshClaims;
    if (typeof claims.sid !== 'string' || typeof claims.at !== 'string' || typeof claims.jti !== 'string') return null;
    if (typeof claims.exp !== 'number' || claims.exp <= now) return null;
    return claims;
  } catch {
    return null;
  }
}
