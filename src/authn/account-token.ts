import { Rejection } from "../http/respond";
import type { AccountTokenAuthn } from "../tenants/schema";

const SUBJECT = /^[A-Za-z0-9._:-]{1,128}$/;
const PLAN = /^[a-z][a-z0-9_-]{0,30}$/;
const CLOCK_SKEW_SECONDS = 60;
const ECDSA = { name: "ECDSA", namedCurve: "P-256" } as const;

export interface AccountClaims {
  subject: string;
  plan: string;
}

const MAX_CACHED_KEYS = 200;
const keyCache = new Map<string, Promise<CryptoKey>>();

const unauthorized = (): never => {
  throw new Rejection(401, "bad_token");
};

const fromBase64Url = (text: string): Uint8Array<ArrayBuffer> => {
  const padded = text
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(text.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
};

const signatureBytes = (part: string): Uint8Array<ArrayBuffer> => {
  try {
    return fromBase64Url(part);
  } catch {
    return unauthorized();
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const decodeJson = (part: string): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(fromBase64Url(part)));
    return isRecord(value) ? value : unauthorized();
  } catch {
    return unauthorized();
  }
};

const importKey = async (authn: AccountTokenAuthn, kid: unknown): Promise<CryptoKey> => {
  const entry = authn.keys.find((key) => key.kid === kid);
  if (entry === undefined) {
    return unauthorized();
  }
  const cacheKey = `${entry.kid}:${entry.jwk.x}:${entry.jwk.y}`;
  const cached = keyCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const imported = crypto.subtle
    .importKey("jwk", entry.jwk, ECDSA, false, ["verify"])
    .catch((error: unknown) => {
      keyCache.delete(cacheKey);
      throw error;
    });
  if (keyCache.size >= MAX_CACHED_KEYS) {
    const oldest = keyCache.keys().next().value;
    if (oldest !== undefined) {
      keyCache.delete(oldest);
    }
  }
  keyCache.set(cacheKey, imported);
  return imported;
};

const audienceMatches = (claim: unknown, audience: string): boolean =>
  claim === audience || (Array.isArray(claim) && claim.includes(audience));

const isCurrent = (claims: Record<string, unknown>, nowSeconds: number): boolean => {
  const { exp, nbf } = claims;
  const notExpired = typeof exp === "number" && exp + CLOCK_SKEW_SECONDS > nowSeconds;
  const started =
    nbf === undefined || (typeof nbf === "number" && nbf - CLOCK_SKEW_SECONDS <= nowSeconds);
  return notExpired && started;
};

const claimsOf = (
  claims: Record<string, unknown>,
  authn: AccountTokenAuthn,
  now: number,
): AccountClaims => {
  const { sub, plan } = claims;
  const trusted = claims["iss"] === authn.issuer && audienceMatches(claims["aud"], authn.audience);
  if (!trusted || !isCurrent(claims, Math.floor(now / 1000))) {
    return unauthorized();
  }
  if (
    typeof sub !== "string" ||
    !SUBJECT.test(sub) ||
    typeof plan !== "string" ||
    !PLAN.test(plan)
  ) {
    return unauthorized();
  }
  return { subject: sub, plan };
};

export const verifyAccountToken = async (
  token: string,
  authn: AccountTokenAuthn,
  now: number,
): Promise<AccountClaims> => {
  const [head, body, signature, ...rest] = token.split(".");
  if (head === undefined || body === undefined || signature === undefined || rest.length > 0) {
    return unauthorized();
  }
  const header = decodeJson(head);
  if (header["alg"] !== "ES256") {
    return unauthorized();
  }
  const key = await importKey(authn, header["kid"]);
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    signatureBytes(signature),
    new TextEncoder().encode(`${head}.${body}`),
  );
  return valid ? claimsOf(decodeJson(body), authn, now) : unauthorized();
};
