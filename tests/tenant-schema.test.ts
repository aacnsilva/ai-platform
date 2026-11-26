import { describe, expect, it } from "vitest";

import course from "../examples/tenants/course.tenant.json" with { type: "json" };
import demo from "../examples/tenants/demo.tenant.json" with { type: "json" };
import { tenantSchema } from "../src/tenants/schema";

describe("tenant schema", () => {
  it("accepts both example tenants", () => {
    expect(tenantSchema.safeParse(demo).success).toBe(true);
    expect(tenantSchema.safeParse(course).success).toBe(true);
  });

  it.each([
    ["a chat agent for anonymous callers", { authn: demo.authn }],
    ["an authenticated tenant with no plans", { plans: {} }],
    ["a fetch tool whose host is not on the egress list", { egress: { allowedHosts: [] } }],
  ])("refuses %s", (_name, overrides) => {
    expect(tenantSchema.safeParse({ ...course, ...overrides }).success).toBe(false);
  });

  it("refuses a tool the runtime runs that is not read-only, and server tools on a stateless agent", () => {
    const [contract] = course.agent.contracts;
    const [fetchTool] = contract?.tools ?? [];
    const writer = { ...contract, tools: [{ ...fetchTool, effect: "write" }] };
    const writes = { ...course, agent: { ...course.agent, contracts: [writer] } };
    expect(tenantSchema.safeParse(writes).success).toBe(false);
    const stateless = { ...course, agent: { ...course.agent, state: "stateless" } };
    expect(tenantSchema.safeParse(stateless).success).toBe(false);
  });

  it.each([
    ["an id with capitals", { id: "Demo" }],
    ["a pool above the hard ceiling", { limits: { ...demo.limits, poolEurPerMonth: 5001 } }],
    ["a network limit of zero", { limits: { ...demo.limits, ipPerHour: 0 } }],
    ["an origin that is not a URL", { authn: { kind: "anonymous", allowedOrigins: ["nope"] } }],
    [
      "an origin with a trailing slash",
      { authn: { kind: "anonymous", allowedOrigins: ["https://example.com/"] } },
    ],
    [
      "an origin with a path",
      { authn: { kind: "anonymous", allowedOrigins: ["https://example.com/app"] } },
    ],
    ["an unknown authenticator", { authn: { kind: "magic", allowedOrigins: [] } }],
  ])("refuses %s", (_name, overrides) => {
    expect(tenantSchema.safeParse({ ...demo, ...overrides }).success).toBe(false);
  });

  it("refuses an unparseable http tool url", () => {
    const [contract] = course.agent.contracts;
    const [fetchTool] = contract?.tools ?? [];
    const dynamicHost = {
      ...contract,
      tools: [{ ...fetchTool, run: { kind: "http", url: "https://{host}/items" } }],
    };
    const broken = { ...course, agent: { ...course.agent, contracts: [dynamicHost] } };
    expect(tenantSchema.safeParse(broken).success).toBe(false);
  });

  it("refuses a locale pattern that is not a regular expression", () => {
    const gate = { ...demo.agent.gate, locales: [{ pattern: "(", refusal: "x", unreadable: "y" }] };
    const broken = { ...demo, agent: { ...demo.agent, gate } };
    expect(tenantSchema.safeParse(broken).success).toBe(false);
  });
});
