import { beforeAll, describe, expect, it } from "vitest";

import type { CreatedTenant } from "./support/chat.ts";
import { createChatTenant, post, serverTools, textOf, tokenFor, turn } from "./support/chat.ts";
import { runtimeUrl } from "./support/client.ts";

type Json = Record<string, unknown>;

const documents = async (
  tenant: CreatedTenant,
  path: string,
  init: RequestInit = {},
): Promise<Response> =>
  fetch(`${runtimeUrl()}/admin/api/tenants/${tenant.id}/documents${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${process.env["E2E_ADMIN_TOKEN"] ?? ""}`,
      "content-type": "application/json",
    },
  });

const putDocument = async (tenant: CreatedTenant, id: string, document: Json): Promise<Json> =>
  (await (
    await documents(tenant, `/${id}`, { method: "PUT", body: JSON.stringify(document) })
  ).json()) as Json;

interface Asker {
  subject: string;
  plan: string;
}

const search = async (tenant: CreatedTenant, asker: Asker, query: string): Promise<string> =>
  textOf(
    await post(
      tenant.id,
      await tokenFor(tenant, asker.subject, asker.plan),
      turn(`TOOLCALL search_knowledge query=${query}`),
    ),
  );

const searchTagged = async (
  tenant: CreatedTenant,
  asker: Asker,
  input: { query: string; tag: string },
): Promise<string> =>
  textOf(
    await post(
      tenant.id,
      await tokenFor(tenant, asker.subject, asker.plan),
      turn(`TOOLCALL search_knowledge json=${JSON.stringify(input)}`),
    ),
  );

const BRAKES = {
  title: "Brake pads",
  text: "# Brake pads\n\nCheck the pads for wear every month. MARKER-BRAKES\n\nReplace them below one millimetre.",
};
const ADVANCED = {
  title: "Wheel truing",
  text: "Wheel truing aligns the rim with a spoke key. MARKER-WHEELS",
  plans: ["pro"],
};

describe("knowledge retrieval per tenant", () => {
  let tenant: CreatedTenant;

  beforeAll(async () => {
    tenant = await createChatTenant({
      state: "stored",
      tools: serverTools(),
      extra: { knowledge: { embeddingModel: "mock-embed", topK: 3 } },
    });
    await putDocument(tenant, "brake-pads", BRAKES);
    await putDocument(tenant, "wheel-truing", ADVANCED);
  });

  it("chunks and embeds a document once, and skips an unchanged one", async () => {
    const stored = await putDocument(tenant, "tyre-pressure", {
      title: "Tyre pressure",
      text: "Road tyres run at six to eight bar.",
    });
    expect(stored).toMatchObject({ ok: true, chunks: 1, embedded: true });
    const again = await putDocument(tenant, "tyre-pressure", {
      title: "Tyre pressure",
      text: "Road tyres run at six to eight bar.",
    });
    expect(again).toMatchObject({ ok: true, unchanged: true });
    const list = (await (await documents(tenant, "")).json()) as { id: string }[];
    expect(list.map((entry) => entry.id)).toEqual(["brake-pads", "tyre-pressure", "wheel-truing"]);
  });

  it("finds a passage and cites the document it came from", async () => {
    const answer = await search(
      tenant,
      { subject: "k-basic", plan: "basic" },
      "pads for wear every month",
    );
    expect(answer).toContain("MARKER-BRAKES");
    expect(answer).toContain("Brake pads (brake-pads)");
  });

  it("shows a document restricted to a plan only to subjects on that plan", async () => {
    expect(
      await search(tenant, { subject: "k-basic-2", plan: "basic" }, "wheel truing spoke key"),
    ).not.toContain("MARKER-WHEELS");
    expect(
      await search(tenant, { subject: "k-pro", plan: "pro" }, "wheel truing spoke key"),
    ).toContain("MARKER-WHEELS");
  });

  it("never returns another tenant's documents", async () => {
    const other = await createChatTenant({ state: "stored", tools: serverTools() });
    const answer = await search(
      other,
      { subject: "k-other", plan: "pro" },
      "pads for wear every month",
    );
    expect(answer).toContain("Nothing in the knowledge base matched");
  });

  it("forgets a deleted document", async () => {
    await putDocument(tenant, "chain-oil", {
      title: "Chain oil",
      text: "Chain oil keeps the links quiet. MARKER-CHAIN",
    });
    expect(
      await search(tenant, { subject: "k-del", plan: "basic" }, "chain oil links quiet"),
    ).toContain("MARKER-CHAIN");
    expect(await (await documents(tenant, "/chain-oil", { method: "DELETE" })).json()).toEqual({
      ok: true,
      removed: true,
    });
    expect(
      await search(tenant, { subject: "k-del-2", plan: "basic" }, "chain oil links quiet"),
    ).not.toContain("MARKER-CHAIN");
  });

  it("falls back to keyword search for a tenant with no embedding model", async () => {
    const keywordOnly = await createChatTenant({ state: "stored", tools: serverTools() });
    const stored = await putDocument(keywordOnly, "gear-indexing", {
      title: "Gear indexing",
      text: "Gear indexing sets each click to one sprocket. MARKER-GEARS",
    });
    expect(stored).toMatchObject({ chunks: 1, embedded: false });
    expect(
      await search(keywordOnly, { subject: "k-kw", plan: "basic" }, "gear indexing sprocket"),
    ).toContain("MARKER-GEARS");
  });

  it("keeps document management behind the admin token and validates what it is given", async () => {
    const anonymous = await fetch(`${runtimeUrl()}/admin/api/tenants/${tenant.id}/documents`);
    expect(anonymous.status).toBe(401);
    const invalid = await documents(tenant, "/empty", {
      method: "PUT",
      body: JSON.stringify({ title: "x" }),
    });
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as Json)["error"]).toBe("bad_document");
    const unknownPlan = await documents(tenant, "/bad-plan", {
      method: "PUT",
      body: JSON.stringify({ title: "x", text: "body", plans: ["nonexistent"] }),
    });
    expect(unknownPlan.status).toBe(400);
    expect(((await unknownPlan.json()) as Json)["error"]).toBe("bad_document");
  });

  it("reads a single document with its plans and chunks, and clears knowledge on tenant delete", async () => {
    const read = (await (await documents(tenant, "/wheel-truing")).json()) as {
      id: string;
      plans: string[] | null;
      texts: string[];
    };
    expect(read.id).toBe("wheel-truing");
    expect(read.plans).toEqual(["pro"]);
    expect(read.texts[0]).toContain("MARKER-WHEELS");
    const list = (await (await documents(tenant, "")).json()) as {
      id: string;
      plans: string[] | null;
    }[];
    expect(list.find((entry) => entry.id === "wheel-truing")?.plans).toEqual(["pro"]);
    const temp = await createChatTenant({ state: "stored", tools: serverTools() });
    await putDocument(temp, "temp-doc", BRAKES);
    const saved = (await (
      await fetch(`${runtimeUrl()}/admin/api/tenants/${temp.id}`, {
        headers: { authorization: `Bearer ${process.env["E2E_ADMIN_TOKEN"] ?? ""}` },
      })
    ).json()) as { tenant: Json };
    expect(
      (
        await fetch(`${runtimeUrl()}/admin/api/tenants/${temp.id}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${process.env["E2E_ADMIN_TOKEN"] ?? ""}` },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(`${runtimeUrl()}/admin/api/tenants/${temp.id}`, {
          method: "PUT",
          headers: {
            authorization: `Bearer ${process.env["E2E_ADMIN_TOKEN"] ?? ""}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(saved.tenant),
        })
      ).status,
    ).toBe(200);
    expect((await (await documents(temp, "")).json()) as unknown[]).toEqual([]);
  });

  it("filters search results by tag while keeping untagged documents visible", async () => {
    const tagged = await createChatTenant({ state: "stored", tools: serverTools() });
    await putDocument(tagged, "shared-rules", {
      title: "Shared rules",
      text: "Functions appear across exams. MARKER-GLOBAL",
    });
    await putDocument(tagged, "math-doc", {
      title: "Math functions",
      text: "Functions in calculus have derivatives. MARKER-MATH",
      tags: ["math"],
    });
    await putDocument(tagged, "grammar-doc", {
      title: "Syntactic functions",
      text: "Functions in syntax include subject and predicate. MARKER-GRAMMAR",
      tags: ["grammar"],
    });

    const mathReply = await searchTagged(
      tagged,
      { subject: "k-tag-1", plan: "basic" },
      { query: "functions", tag: "math" },
    );
    expect(mathReply).toContain("MARKER-MATH");
    expect(mathReply).toContain("MARKER-GLOBAL");
    expect(mathReply).not.toContain("MARKER-GRAMMAR");

    const grammarReply = await searchTagged(
      tagged,
      { subject: "k-tag-2", plan: "basic" },
      { query: "functions", tag: "grammar" },
    );
    expect(grammarReply).toContain("MARKER-GRAMMAR");
    expect(grammarReply).not.toContain("MARKER-MATH");

    const stored = (await (await documents(tagged, "/math-doc")).json()) as {
      tags: string[] | null;
    };
    expect(stored.tags).toEqual(["math"]);
  });
});
