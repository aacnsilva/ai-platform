import { describe, expect, it } from "vitest";

import { runtimeUrl } from "./support/client.ts";

type Json = Record<string, unknown>;

const admin = async (path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`${runtimeUrl()}/admin/api${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${process.env["E2E_ADMIN_TOKEN"] ?? ""}`,
      "content-type": "application/json",
    },
  });

interface Template {
  id: string;
  tenant: Json;
}

const templates = async (): Promise<Template[]> =>
  (await (await admin("/templates")).json()) as Template[];

const withId = (tenant: Json, id: string): Json => ({ ...tenant, id });

describe("tenant administration", () => {
  it("offers starting documents that are valid as they are", async () => {
    const offered = await templates();
    expect(offered.map((template) => template.id)).toEqual([
      "question-box",
      "account-chat",
      "device-chat",
    ]);
    for (const template of offered) {
      const response = await admin("/validate-tenant", {
        method: "POST",
        body: JSON.stringify(template.tenant),
      });
      expect([template.id, response.status]).toEqual([template.id, 200]);
    }
  });

  it("checks a document without saving it, and says what is wrong", async () => {
    const [box] = await templates();
    const id = `adm-dry-${String(Date.now())}`;
    const valid = await admin("/validate-tenant", {
      method: "POST",
      body: JSON.stringify(withId(box?.tenant ?? {}, id)),
    });
    expect(valid.status).toBe(200);
    expect((await admin(`/tenants/${id}`)).status).toBe(404);
    const broken = await admin("/validate-tenant", {
      method: "POST",
      body: JSON.stringify({ ...withId(box?.tenant ?? {}, id), limits: { ipPerHour: 0 } }),
    });
    expect(broken.status).toBe(400);
    expect(((await broken.json()) as { message: string }).message).toContain("limits");
  });

  it("saves, reads back with defaults and tool hashes, lists, and deletes a tenant", async () => {
    const chat = (await templates()).find((template) => template.id === "device-chat");
    const id = `adm-${String(Date.now())}`;
    const saved = await admin(`/tenants/${id}`, {
      method: "PUT",
      body: JSON.stringify(withId(chat?.tenant ?? {}, id)),
    });
    expect(saved.status).toBe(200);
    const read = (await (await admin(`/tenants/${id}`)).json()) as {
      tenant: { agent: { counting: string; contracts: unknown[] } };
      contracts: { version: number; hash: string; tools: number }[];
    };
    expect(read.tenant.agent.counting).toBe("first_round_free");
    expect(read.contracts).toHaveLength(1);
    expect(read.contracts[0]).toMatchObject({ version: 1, tools: 0 });
    expect(read.contracts[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
    const listed = (await (await admin("/tenants")).json()) as Json[];
    expect(listed.find((entry) => entry["id"] === id)).toMatchObject({
      agent: "chat, stateless",
      authn: "app_attest",
      plans: 1,
      evals: false,
    });
    expect(await (await admin(`/tenants/${id}`, { method: "DELETE" })).json()).toEqual({
      ok: true,
      removed: true,
    });
    expect((await admin(`/tenants/${id}`)).status).toBe(404);
    const gone = await fetch(`${runtimeUrl()}/v1/tenants/${id}/status`);
    expect(gone.status).toBe(404);
  });

  it("refuses to save a document under another tenant's address", async () => {
    const [box] = await templates();
    const response = await admin("/tenants/adm-other", {
      method: "PUT",
      body: JSON.stringify(withId(box?.tenant ?? {}, "adm-mismatch")),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as Json)["error"]).toBe("id_mismatch");
  });

  it("serves the tenants page without data, and keeps its API behind the admin token", async () => {
    const page = await fetch(`${runtimeUrl()}/admin/tenants`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const body = await page.text();
    expect(body).toContain("Enter the admin token to manage tenants");
    expect(body).toContain("delete-dialog");
    for (const path of ["/tenants", "/templates", "/tenants/demo"]) {
      expect((await fetch(`${runtimeUrl()}/admin/api${path}`)).status).toBe(401);
    }
  });
});
