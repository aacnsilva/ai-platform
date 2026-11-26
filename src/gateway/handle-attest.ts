import { bytesToBase64Url, decodeBase64, verifyAttestation } from "../authn/apple";
import { clientIp } from "../authn/authenticate";
import { attestRoots, deviceName, keyIdFrom } from "../authn/device-authn";
import { readBoundedText } from "../http/read-body";
import { json, Rejection } from "../http/respond";
import { logEvent } from "../observability/log";
import { loadTenant } from "../tenants/registry";
import type { AppAttestAuthn, Tenant } from "../tenants/schema";
import { isRecord } from "./chat-body";
import type { RequestContext } from "./context";
import { rejected } from "./handle-run";

const MAX_CHALLENGE_BODY = 2000;
const MAX_ATTEST_BODY = 32_000;
const CHALLENGE_BYTES = 32;

const LIMIT_MESSAGE = "This network has asked enough for the moment. Try again later.";

interface Target {
  context: RequestContext;
  tenant: Tenant;
  authn: AppAttestAuthn;
}

const readJson = async (request: Request, maxBytes: number): Promise<Record<string, unknown>> => {
  const raw = await readBoundedText(request, maxBytes);
  try {
    const body: unknown = JSON.parse(raw);
    return isRecord(body) ? body : {};
  } catch {
    throw new Rejection(400, "bad_json");
  }
};

const textField = (body: Record<string, unknown>, name: string): string => {
  const value = body[name];
  return typeof value === "string" ? value : "";
};

const noteNetwork = async (target: Target): Promise<void> => {
  const { env, request } = target.context;
  const ledger = env.LEDGER.get(env.LEDGER.idFromName(`attest:${target.tenant.id}`));
  const noted = await ledger.noteNetwork({
    now: Date.now(),
    ip: clientIp(request),
    perHour: target.authn.attestIpPerHour,
    perDay: target.authn.attestIpPerDay,
  });
  if (!noted.ok) {
    throw new Rejection(429, noted.error, {
      message: LIMIT_MESSAGE,
      retryAfterSeconds: noted.retryAfterSeconds,
    });
  }
};

const challenge = async (target: Target): Promise<Response> => {
  const { env, request } = target.context;
  const body = await readJson(request, MAX_CHALLENGE_BODY);
  const keyId = keyIdFrom(textField(body, "keyId"));
  if (keyId === null) {
    throw new Rejection(400, "bad_key");
  }
  await noteNetwork(target);
  const nonce = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(CHALLENGE_BYTES)));
  const store = env.SUBJECT.get(env.SUBJECT.idFromName(deviceName(target.tenant.id, keyId)));
  await store.putChallenge(nonce, Date.now());
  return json({ challenge: nonce }, 200);
};

const attest = async (target: Target): Promise<Response> => {
  const { env, request } = target.context;
  const { authn, tenant } = target;
  const body = await readJson(request, MAX_ATTEST_BODY);
  const keyId = keyIdFrom(textField(body, "keyId"));
  const attestation = decodeBase64(textField(body, "attestation"));
  if (keyId === null || attestation === null) {
    throw new Rejection(400, "bad_attestation");
  }
  await noteNetwork(target);
  const store = env.SUBJECT.get(env.SUBJECT.idFromName(deviceName(tenant.id, keyId)));
  const nonce = await store.takeChallenge(Date.now());
  const issued = nonce === null ? null : decodeBase64(nonce);
  if (issued === null) {
    throw new Rejection(400, "no_challenge");
  }
  const result = verifyAttestation({
    attestation,
    challenge: issued,
    keyId,
    teamId: authn.teamId,
    bundleId: authn.bundleId,
    roots: attestRoots(authn),
    now: Date.now(),
  });
  logEvent("attest", { tenant: tenant.id, ok: result.ok, error: result.ok ? null : result.error });
  if (!result.ok) {
    throw new Rejection(400, "bad_attestation");
  }
  await store.putDevice(result.publicKey, result.environment);
  return json({ ok: true }, 200);
};

export const handleAttest = async (
  context: RequestContext,
  tenantId: string,
  step: string,
): Promise<Response> => {
  const tenant = await loadTenant(context.env, tenantId);
  if (tenant?.authn.kind !== "app_attest") {
    return json({ error: "not_found" }, 404);
  }
  if (context.request.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }
  const target = { context, tenant, authn: tenant.authn };
  try {
    return await (step === "challenge" ? challenge(target) : attest(target));
  } catch (error) {
    if (error instanceof Rejection) {
      return rejected(context, tenant, error);
    }
    throw error;
  }
};
