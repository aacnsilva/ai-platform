import { beforeAll, describe, expect, it } from "vitest";

import {
  adminGet,
  ALLOWED_ORIGIN,
  ask,
  createTenant,
  postRun,
  runsUrl,
  runtimeUrl,
} from "./support/client.ts";

describe("gateway", () => {
  let tenant = "";

  beforeAll(async () => {
    tenant = await createTenant();
  });

  it("reports health and tags every response with a request id", async () => {
    const response = await fetch(`${runtimeUrl()}/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers.get("server-timing")).toContain("gateway;dur=");
  });

  it("answers an unknown tenant like an unknown path", async () => {
    const response = await ask("no-such-tenant", "hello");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("answers the browser preflight for an allowed origin only", async () => {
    const allowed = await fetch(runsUrl(tenant), {
      method: "OPTIONS",
      headers: { origin: ALLOWED_ORIGIN },
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
    const foreign = await fetch(runsUrl(tenant), {
      method: "OPTIONS",
      headers: { origin: "https://evil.example" },
    });
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("refuses a foreign origin before reading the body", async () => {
    const response = await postRun(tenant, "not even json", { origin: "https://evil.example" });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "origin" });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it.each([
    ["bad_json", "{nope"],
    ["missing_messages", { hello: 1 }],
    ["bad_length", { messages: [] }],
    ["bad_role", { messages: [{ role: "system", content: "x" }] }],
    ["bad_content", { messages: [{ role: "user", content: 5 }] }],
    ["question_too_long", { messages: [{ role: "user", content: "x".repeat(801) }] }],
    ["missing_question", { messages: [{ role: "assistant", content: "hi" }] }],
    ["too_large", { messages: [{ role: "user", content: "x".repeat(13_000) }] }],
  ])("rejects a bad body with %s", async (code, body) => {
    const response = await postRun(tenant, body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: code });
    expect(response.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
  });

  it("refuses other methods on a tenant route", async () => {
    const response = await fetch(runsUrl(tenant), { method: "DELETE" });
    expect(response.status).toBe(405);
    expect((await fetch(`${runsUrl(tenant)}/extra`, { method: "POST" })).status).toBe(404);
    expect(
      (await fetch(`${runtimeUrl()}/v1/tenants/${tenant}/status/extra`, { method: "GET" })).status,
    ).toBe(404);
  });

  it("enforces body size caps in UTF-8 bytes", async () => {
    const response = await postRun(tenant, {
      messages: [{ role: "user", content: "€".repeat(4500) }],
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "too_large" });
  });

  it("keeps the admin API behind the admin token", async () => {
    expect((await adminGet("/admin/api/tenants", "wrong-token-wrong-token")).status).toBe(401);
    expect((await adminGet("/admin/api/tenants")).status).toBe(200);
  });

  it("explains what is wrong with an invalid tenant", async () => {
    const response = await fetch(`${runtimeUrl()}/admin/api/tenants/broken`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${process.env["E2E_ADMIN_TOKEN"] ?? ""}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ id: "broken", name: "Broken" }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("bad_tenant");
    expect(body.message).toContain("limits");
  });
});
