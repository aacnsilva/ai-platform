import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { AccountClaims } from "../../src/authn/account-token";
import { verifyAccountToken } from "../../src/authn/account-token";
import { Rejection } from "../../src/http/respond";
import { readIdempotencyKey, sessionIdFor } from "../../src/sessions/idempotency";
import type { AccountTokenAuthn } from "../../src/tenants/schema";
import type { Issuer } from "../support/tokens";
import { createIssuer } from "../support/tokens";

const NOW = Date.UTC(2026, 10, 20);
const NOW_SECONDS = NOW / 1000;
const ISSUER = "https://accounts.example.test";
const AUDIENCE = "example-runtime";
const GOOD = { iss: ISSUER, aud: AUDIENCE, sub: "user-1", plan: "free", exp: NOW_SECONDS + 600 };

const authnFor = (issuer: Issuer): AccountTokenAuthn => ({
  kind: "account_token",
  allowedOrigins: [],
  issuer: ISSUER,
  audience: AUDIENCE,
  keys: [{ kid: issuer.kid, jwk: issuer.jwk }],
});

const outcome = async (token: string, authn: AccountTokenAuthn): Promise<AccountClaims | null> => {
  try {
    return await verifyAccountToken(token, authn, NOW);
  } catch (error) {
    if (error instanceof Rejection && error.status === 401 && error.code === "bad_token") {
      return null;
    }
    throw error;
  }
};

const edits = fc.record({
  at: fc.double({ min: 0, max: 1, noNaN: true, maxExcluded: true }),
  text: fc.string({ unit: "binary", maxLength: 3 }),
  drop: fc.integer({ min: 0, max: 3 }),
});

const edit = (text: string, change: { at: number; text: string; drop: number }): string => {
  const at = Math.floor(change.at * text.length);
  return text.slice(0, at) + change.text + text.slice(at + change.drop);
};

const claimValues = fc.oneof(
  fc.constantFrom(ISSUER, AUDIENCE, "user-1", "free", NOW_SECONDS + 600, NOW_SECONDS - 600),
  fc.anything(),
);

describe("account token under hostile text", () => {
  it("answers any text with 401 and nothing else", async () => {
    const issuer = await createIssuer();
    const authn = authnFor(issuer);
    const good = await issuer.sign(GOOD);
    const [head = "", body = ""] = good.split(".");
    const tails = fc.string({ unit: "binary", maxLength: 100 });
    const texts = fc.oneof(
      fc.string({ unit: "binary", maxLength: 200 }),
      tails.map((tail) => `${head}.${body}.${tail}`),
      fc
        .array(fc.base64String({ maxLength: 80 }), { maxLength: 5 })
        .map((parts) => parts.join(".")),
    );
    await fc.assert(
      fc.asyncProperty(texts, async (token) => {
        expect(await outcome(token, authn)).toBeNull();
      }),
      { numRuns: 2000 },
    );
  });

  it("never reads different claims out of an edited token", async () => {
    const issuer = await createIssuer();
    const authn = authnFor(issuer);
    const good = await issuer.sign(GOOD);
    const genuine = await outcome(good, authn);
    expect(genuine).toEqual({ subject: "user-1", plan: "free" });
    await fc.assert(
      fc.asyncProperty(edits, async (change) => {
        expect((await outcome(edit(good, change), authn)) ?? genuine).toEqual(genuine);
      }),
      { numRuns: 1500 },
    );
  });

  it("accepts only current claims for this issuer and audience, signed by a listed key", async () => {
    const issuer = await createIssuer();
    const stranger = await createIssuer(issuer.kid);
    const authn = authnFor(issuer);
    const claims = fc.record(
      {
        iss: claimValues,
        aud: claimValues,
        sub: claimValues,
        plan: claimValues,
        exp: claimValues,
        nbf: claimValues,
      },
      { requiredKeys: [] },
    );
    const headers = fc.constantFrom({}, { alg: "none" }, { alg: "HS256" }, { kid: "other" });
    await fc.assert(
      fc.asyncProperty(claims, headers, fc.boolean(), async (drawn, header, forged) => {
        const token = await (forged ? stranger : issuer).sign(drawn, header);
        const accepted = await outcome(token, authn);
        if (accepted === null) {
          return;
        }
        expect(forged).toBe(false);
        expect(header).toEqual({});
        expect(drawn.iss).toBe(ISSUER);
        expect(
          drawn.aud === AUDIENCE || (Array.isArray(drawn.aud) && drawn.aud.includes(AUDIENCE)),
        ).toBe(true);
        expect(typeof drawn.exp === "number" && drawn.exp + 60 > NOW_SECONDS).toBe(true);
        expect(accepted).toEqual({ subject: drawn.sub, plan: drawn.plan });
        expect(accepted.subject).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
        expect(accepted.plan).toMatch(/^[a-z][a-z0-9_-]{0,30}$/);
      }),
      { numRuns: 1500 },
    );
  });
});

describe("idempotency key under hostile text", () => {
  it("keeps only short printable keys and always names a session with a UUID", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ unit: "binary", maxLength: 200 }),
        fc.string({ unit: "binary", maxLength: 50 }),
        async (header, subject) => {
          const reading = readIdempotencyKey(header);
          if (!reading.ok || reading.key === null) {
            expect(reading.ok).toBe(false);
            return;
          }
          expect(reading.key).toMatch(/^[\x21-\x7e]{1,128}$/);
          expect(await sessionIdFor(subject, reading.key)).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
          );
        },
      ),
      { numRuns: 1000 },
    );
  });
});
