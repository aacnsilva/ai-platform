import { beforeAll, describe, expect, it } from "vitest";

import { verifyAccountToken } from "../src/authn/account-token";
import { Rejection } from "../src/http/respond";
import type { AccountTokenAuthn } from "../src/tenants/schema";
import type { Issuer } from "./support/tokens";
import { createIssuer } from "./support/tokens";

const NOW = Date.UTC(2026, 10, 20);
const SECONDS = NOW / 1000;

describe("account token", () => {
  let issuer: Issuer;
  let authn: AccountTokenAuthn;
  const claims = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    iss: "https://accounts.example",
    aud: "ai-platform",
    sub: "user_42",
    plan: "plus",
    exp: SECONDS + 300,
    ...overrides,
  });
  const outcome = async (token: string): Promise<unknown> =>
    verifyAccountToken(token, authn, NOW).catch((error: unknown) =>
      error instanceof Rejection ? error.code : "threw something else",
    );

  beforeAll(async () => {
    issuer = await createIssuer();
    authn = {
      kind: "account_token",
      allowedOrigins: [],
      issuer: "https://accounts.example",
      audience: "ai-platform",
      keys: [{ kid: issuer.kid, jwk: issuer.jwk }],
    };
  });

  it("reads the subject and plan from a token its issuer signed", async () => {
    expect(await outcome(await issuer.sign(claims()))).toEqual({
      subject: "user_42",
      plan: "plus",
    });
    expect(await outcome(await issuer.sign(claims({ aud: ["other", "ai-platform"] })))).toEqual({
      subject: "user_42",
      plan: "plus",
    });
  });

  it.each([
    ["expired", { exp: SECONDS - 120 }],
    ["not started yet", { nbf: SECONDS + 600 }],
    ["without an expiry", { exp: undefined }],
    ["from another issuer", { iss: "https://evil.example" }],
    ["for another audience", { aud: "someone-else" }],
    ["without a subject", { sub: "" }],
    ["with a subject that is not an identifier", { sub: "a b/c" }],
    ["without a plan", { plan: undefined }],
  ])("refuses a token %s", async (_name, overrides) => {
    expect(await outcome(await issuer.sign(claims(overrides)))).toBe("bad_token");
  });

  it("refuses a token signed by a key the tenant does not list", async () => {
    const stranger = await createIssuer();
    expect(await outcome(await stranger.sign(claims()))).toBe("bad_token");
    const unknownKid = await createIssuer("key-2");
    expect(await outcome(await unknownKid.sign(claims()))).toBe("bad_token");
  });

  it("refuses a token whose claims were changed after signing", async () => {
    const [head, , signature] = (await issuer.sign(claims())).split(".");
    const forged = btoa(JSON.stringify(claims({ plan: "pro" }))).replaceAll("=", "");
    expect(await outcome(`${head ?? ""}.${forged}.${signature ?? ""}`)).toBe("bad_token");
  });

  it.each(["", "a.b", "a.b.c.d", "!!!.###.$$$"])(
    "refuses the malformed token %j",
    async (token) => {
      expect(await outcome(token)).toBe("bad_token");
    },
  );

  it("refuses an unsigned token that names another algorithm", async () => {
    expect(await outcome(await issuer.sign(claims(), { alg: "none" }))).toBe("bad_token");
  });
});
