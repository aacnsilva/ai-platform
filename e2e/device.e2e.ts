import { beforeAll, describe, expect, it } from "vitest";

import type { FakeDevice, FakeStore } from "../tests/apple/device-fixture.ts";
import { createFakeDevice, createFakeStore } from "../tests/apple/device-fixture.ts";
import type { CreatedTenant } from "./support/chat.ts";
import { CLIENT_TOOLS, createChatTenant, question } from "./support/chat.ts";
import { runtimeUrl } from "./support/client.ts";

const TEAM = "ABCDE12345";
const BUNDLE = "com.example.app";

type Json = Record<string, unknown>;

interface Sent {
  status: number;
  body: { error?: string; quota?: { used: number; limit: number } };
}

const postJson = async (tenant: CreatedTenant, path: string, body: Json): Promise<Response> =>
  fetch(`${runtimeUrl()}/v1/tenants/${tenant.id}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const enroll = async (tenant: CreatedTenant, device: FakeDevice): Promise<Response> => {
  const issued = (await (
    await postJson(tenant, "attest/challenge", { keyId: device.keyId })
  ).json()) as {
    challenge: string;
  };
  const attestation = device.attest(Buffer.from(issued.challenge, "base64url"));
  return postJson(tenant, "attest/key", { keyId: device.keyId, attestation });
};

interface Signed {
  body: string;
  headers: Record<string, string>;
}

const sign = (device: FakeDevice, body: Json, transaction: Record<string, string>): Signed => {
  const raw = JSON.stringify(body);
  const jws = Object.values(transaction)[0] ?? "";
  return {
    body: raw,
    headers: {
      "content-type": "application/json",
      "x-device-key-id": device.keyId,
      "x-device-assertion": device.assert(Buffer.from(`${raw}\n${jws}`)),
      ...transaction,
    },
  };
};

const send = async (tenant: CreatedTenant, signed: Signed): Promise<Sent> => {
  const response = await fetch(`${runtimeUrl()}/v1/tenants/${tenant.id}/runs`, {
    method: "POST",
    headers: signed.headers,
    body: signed.body,
  });
  return { status: response.status, body: (await response.json()) as Sent["body"] };
};

interface World {
  tenant: CreatedTenant;
  device: FakeDevice;
  store: FakeStore;
}

const createWorld = async (authn: Json = {}, development = false): Promise<World> => {
  const device = createFakeDevice({ teamId: TEAM, bundleId: BUNDLE, development });
  const store = createFakeStore({ bundleId: BUNDLE });
  const tenant = await createChatTenant({
    state: "stateless",
    tools: CLIENT_TOOLS,
    plans: { plus: { messagesPerMonth: 3 } },
    authn: {
      kind: "app_attest",
      teamId: TEAM,
      bundleId: BUNDLE,
      storeEnvironment: "Production",
      products: { "example.plan.monthly": "plus" },
      roots: { attest: device.rootPem, store: [store.rootPem] },
      ...authn,
    },
  });
  return { tenant, device, store };
};

describe("an attested device with a store subscription", () => {
  let world: World;
  const subscribed = (body: Json, overrides: Json = {}): Signed =>
    sign(world.device, body, { "x-store-transaction": world.store.transaction(overrides) });

  beforeAll(async () => {
    world = await createWorld();
    expect((await enroll(world.tenant, world.device)).status).toBe(200);
  });

  it("is answered, and its messages count against the subscription's plan", async () => {
    const sent = await send(world.tenant, subscribed(question("hello from the app")));
    expect(sent.status).toBe(200);
    expect(sent.body.quota).toEqual({ used: 1, limit: 3 });
  });

  it("cannot replay a request it already sent", async () => {
    const signed = subscribed(question("send me once"));
    expect((await send(world.tenant, signed)).status).toBe(200);
    const replayed = await send(world.tenant, signed);
    expect(replayed.status).toBe(401);
    expect(replayed.body.error).toBe("replay");
  });

  it("cannot change the body after signing it", async () => {
    const signed = subscribed(question("the signed question"));
    const tampered = { ...signed, body: JSON.stringify(question("a different question")) };
    const sent = await send(world.tenant, tampered);
    expect(sent.status).toBe(401);
    expect(sent.body.error).toBe("bad_assertion");
  });

  it("is refused without an assertion, and when its key was never attested", async () => {
    const bare = await send(world.tenant, {
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    expect(bare.body.error).toBe("missing_assertion");
    const stranger = createFakeDevice({ teamId: TEAM, bundleId: BUNDLE });
    const unknown = await send(
      world.tenant,
      sign(stranger, question("hi"), { "x-store-transaction": world.store.transaction() }),
    );
    expect(unknown.status).toBe(401);
    expect(unknown.body.error).toBe("unknown_device");
  });

  it("is refused when the subscription has lapsed, is for another product, or is missing", async () => {
    const lapsed = await send(
      world.tenant,
      subscribed(question("hi"), { expiresDate: Date.now() - 60_000 }),
    );
    expect(lapsed.status).toBe(403);
    expect(lapsed.body.error).toBe("entitlement_inactive");
    const otherProduct = await send(
      world.tenant,
      subscribed(question("hi"), { productId: "example.other" }),
    );
    expect(otherProduct.status).toBe(403);
    const none = await send(world.tenant, sign(world.device, question("hi"), {}));
    expect(none.body.error).toBe("missing_transaction");
  });

  it("does not exist for a purchase from the other store environment", async () => {
    const sandbox = await send(
      world.tenant,
      subscribed(question("hi"), { environment: "Sandbox" }),
    );
    expect(sandbox.status).toBe(404);
  });

  it("refuses a purchase signed by someone other than the store", async () => {
    const forged = createFakeStore({ bundleId: BUNDLE }).transaction();
    const sent = await send(
      world.tenant,
      sign(world.device, question("hi"), { "x-store-transaction": forged }),
    );
    expect(sent.status).toBe(401);
    expect(sent.body.error).toBe("bad_transaction");
  });

  it("uses each attestation challenge once", async () => {
    const device = createFakeDevice({ teamId: TEAM, bundleId: BUNDLE });
    const attestation = device.attest(Buffer.from("no challenge was ever issued"));
    const response = await postJson(world.tenant, "attest/key", {
      keyId: device.keyId,
      attestation,
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as Json)["error"]).toBe("no_challenge");
  });

  it("rejects an attestation from an app with another identity", async () => {
    const impostor = createFakeDevice({ teamId: TEAM, bundleId: "com.example.other" });
    const response = await enroll(world.tenant, impostor);
    expect(response.status).toBe(400);
    expect(((await response.json()) as Json)["error"]).toBe("bad_attestation");
  });

  it("answers OPTIONS preflight and refuses GET with 405 on attest routes", async () => {
    const url = `${runtimeUrl()}/v1/tenants/${world.tenant.id}/attest/challenge`;
    expect((await fetch(url, { method: "OPTIONS" })).status).toBe(204);
    expect((await fetch(url, { method: "GET" })).status).toBe(405);
  });
});

describe("a test environment tenant", () => {
  const SANDBOX = {
    storeEnvironment: "Sandbox",
    installPlan: "plus",
    developmentPlan: "plus",
  };

  it("accepts a test install's own receipt in place of a subscription", async () => {
    const world = await createWorld(SANDBOX);
    await enroll(world.tenant, world.device);
    const sent = await send(
      world.tenant,
      sign(world.device, question("hi"), { "x-app-transaction": world.store.appTransaction() }),
    );
    expect(sent.status).toBe(200);
    expect(sent.body.quota).toEqual({ used: 1, limit: 3 });
  });

  it("accepts a development build's key alone, and a production tenant does not", async () => {
    const sandbox = await createWorld(SANDBOX, true);
    await enroll(sandbox.tenant, sandbox.device);
    expect((await send(sandbox.tenant, sign(sandbox.device, question("hi"), {}))).status).toBe(200);
    const production = await createWorld({}, true);
    await enroll(production.tenant, production.device);
    const refused = await send(production.tenant, sign(production.device, question("hi"), {}));
    expect(refused.body.error).toBe("missing_transaction");
  });
});
