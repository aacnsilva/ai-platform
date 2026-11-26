import { z } from "zod";

const isRegex = (pattern: string): boolean => {
  try {
    new RegExp(pattern, "i");
    return true;
  } catch {
    return false;
  }
};

const shortText = z.string().min(1).max(600);
const pattern = z.string().min(1).max(800).refine(isRegex, "must be a regular expression");
const planId = z.string().regex(/^[a-z][a-z0-9_-]{0,30}$/);
const tier = z.enum(["fast", "balanced"]);
const effort = z.enum(["low", "medium", "high"]);
const isPureOrigin = (value: string): boolean => {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
};

const origins = z
  .array(z.url().refine(isPureOrigin, "must be an origin without a path or trailing slash"))
  .max(20);
const outputTokens = z.number().int().min(256).max(4000);
const systemPrompt = z.string().min(1).max(400_000);

const anonymousAuthn = z.object({ kind: z.literal("anonymous"), allowedOrigins: origins });

const publicKey = z.object({
  kid: z.string().min(1).max(100),
  jwk: z.object({
    kty: z.literal("EC"),
    crv: z.literal("P-256"),
    x: z.string().min(40).max(50),
    y: z.string().min(40).max(50),
  }),
});

const accountTokenAuthn = z.object({
  kind: z.literal("account_token"),
  allowedOrigins: origins,
  issuer: z.string().min(1).max(200),
  audience: z.string().min(1).max(200),
  keys: z.array(publicKey).min(1).max(5),
});

const pem = z.string().includes("BEGIN CERTIFICATE").max(8000);

const appAttestAuthn = z.object({
  kind: z.literal("app_attest"),
  allowedOrigins: origins.default([]),
  teamId: z.string().regex(/^[A-Z0-9]{10}$/),
  bundleId: z.string().regex(/^[A-Za-z0-9.-]{1,155}$/),
  storeEnvironment: z.enum(["Production", "Sandbox"]),
  products: z.record(z.string().min(1).max(100), planId),
  developmentPlan: planId.optional(),
  installPlan: planId.optional(),
  attestIpPerHour: z.number().int().min(1).max(1000).default(30),
  attestIpPerDay: z.number().int().min(1).max(5000).default(120),
  roots: z.object({ attest: pem, store: z.array(pem).min(1).max(4) }).optional(),
});

const authnSchema = z.discriminatedUnion("kind", [
  anonymousAuthn,
  accountTokenAuthn,
  appAttestAuthn,
]);

const planSchema = z.object({
  messagesPerMonth: z.number().int().min(1).max(5000),
  tier: tier.optional(),
});

const limitsSchema = z.object({
  ipPerHour: z.number().int().min(1).max(1000),
  ipPerDay: z.number().int().min(1).max(5000),
  poolEurPerMonth: z.number().min(0).max(5000),
  usdPerEur: z.number().min(0.01).max(100),
});

const localeSchema = z.object({ pattern, refusal: shortText, unreadable: shortText });

const gateSchema = z.object({
  fallback: z.object({ refusal: shortText, unreadable: shortText }),
  locales: z.array(localeSchema).max(10),
});

const gatedInput = z.object({
  maxMessages: z.number().int().min(1).max(60),
  maxUserChars: z.number().int().min(1).max(8000),
  maxAssistantChars: z.number().int().min(1).max(8000),
  maxBodyBytes: z.number().int().min(256).max(240_000),
});

const gatedAgent = z.object({
  kind: z.literal("gated"),
  tier,
  effort,
  maxOutputTokens: outputTokens,
  system: systemPrompt,
  reminder: z.string().min(1).max(1000).optional(),
  input: gatedInput,
  gate: gateSchema,
});

const toolRun = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("client") }),
  z.object({
    kind: z.literal("http"),
    url: z
      .string()
      .max(500)
      .regex(/^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)[:/])/),
  }),
  z.object({ kind: z.literal("knowledge") }),
]);

const toolSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/),
  description: z.string().min(1).max(8000),
  input_schema: z.record(z.string(), z.unknown()),
  effect: z.enum(["read", "write", "external", "irreversible"]),
  run: toolRun,
});

const contractSchema = z.object({
  version: z.number().int().min(1).max(999),
  allowsImages: z.boolean().default(false),
  tools: z.array(toolSchema).max(40),
});

const contextField = z.object({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,30}$/),
  label: z.string().min(1).max(40),
  kind: z.enum(["text", "list"]),
  required: z.boolean().default(true),
  pattern: pattern.optional(),
  allowed: z.array(z.string().min(1).max(80)).max(100).optional(),
  maxChars: z.number().int().min(1).max(400).default(80),
  maxItems: z.number().int().min(0).max(100).default(20),
});

const chatInput = z.object({
  maxMessages: z.number().int().min(1).max(200).default(60),
  maxQuestionChars: z.number().int().min(1).max(8000).default(800),
  maxReplyChars: z.number().int().min(1).max(8000).default(2000),
  maxBlocks: z.number().int().min(1).max(20).default(8),
  maxToolInputChars: z.number().int().min(1).max(20_000).default(4000),
  maxToolResultChars: z.number().int().min(1).max(40_000).default(6000),
  maxConversationChars: z.number().int().min(1000).max(400_000).default(40_000),
  maxConversationTokens: z.number().int().min(250).max(200_000).optional(),
  maxBodyBytes: z.number().int().min(256).max(400_000).default(240_000),
  maxImageBytes: z.number().int().min(0).max(200_000).default(0),
  imageChars: z.number().int().min(0).max(40_000).default(6000),
});

const languageSchema = z.object({
  localeField: z.string().optional(),
  options: z
    .array(z.object({ id: z.string().min(2).max(5), words: pattern, instruction: shortText }))
    .min(1)
    .max(8),
});

const version = z.string().regex(/^\d{1,3}\.\d{1,3}(\.\d{1,3})?$/);

const systemRule = z.object({
  contractVersion: z.number().int().min(1).max(999).optional(),
  versionAtLeast: version.optional(),
  system: systemPrompt,
});

const chatAgent = z.object({
  kind: z.literal("chat"),
  tier,
  effort,
  maxOutputTokens: outputTokens,
  thinking: z.enum(["default", "off"]).default("off"),
  system: systemPrompt,
  reminder: z.string().min(1).max(1000).optional(),
  systems: z.array(systemRule).max(20).default([]),
  versionField: z.string().optional(),
  refusal: z.object({
    fallback: shortText,
    byLanguage: z.record(z.string().min(2).max(5), shortText).default({}),
  }),
  counting: z
    .enum(["first_round_free", "every_call", "questions_only"])
    .default("first_round_free"),
  language: languageSchema.optional(),
  state: z.enum(["stateless", "stored"]),
  maxRounds: z.number().int().min(1).max(20).default(8),
  streamHoldChars: z.number().int().min(0).max(1000).default(120),
  input: chatInput.prefault({}),
  context: z.array(contextField).max(12).default([]),
  contracts: z.array(contractSchema).min(1).max(8),
});

const agentSchema = z.discriminatedUnion("kind", [gatedAgent, chatAgent]);

const knowledgeSchema = z.object({
  chunkChars: z.number().int().min(200).max(4000).default(1200),
  topK: z.number().int().min(1).max(20).default(5),
  embeddingModel: z.string().min(1).max(100).optional(),
});

const evalsSchema = z.object({
  secretSha256: z.string().regex(/^[0-9a-f]{64}$/),
  plan: planId.optional(),
  tiers: z.array(tier).max(4).default([]),
  efforts: z.array(effort).max(3).default([]),
});

const hostname = z.string().regex(/^[a-z0-9]([a-z0-9.-]{0,200}[a-z0-9])?$/);

type Draft = z.infer<typeof draftSchema>;

const planNames = (tenant: Draft): string[] => {
  const { authn } = tenant;
  if (authn.kind !== "app_attest") {
    return [];
  }
  const optional = [authn.developmentPlan, authn.installPlan].filter((name) => name !== undefined);
  return [...Object.values(authn.products), ...optional];
};

const httpToolsAllowed = (tenant: Draft): boolean => {
  if (tenant.agent.kind !== "chat") {
    return true;
  }
  return tenant.agent.contracts
    .flatMap((contract) => contract.tools)
    .every((tool) => {
      if (tool.run.kind !== "http") {
        return true;
      }
      if (!URL.canParse(tool.run.url)) {
        return false;
      }
      return tenant.egress.allowedHosts.includes(new URL(tool.run.url).hostname);
    });
};

const hasUniqueVersions = (tenant: Draft): boolean => {
  if (tenant.agent.kind !== "chat") {
    return true;
  }
  const versions = tenant.agent.contracts.map((contract) => contract.version);
  return new Set(versions).size === versions.length;
};

const toolsOf = (
  tenant: Draft,
): Draft["agent"] extends infer A
  ? A extends { contracts: { tools: infer T }[] }
    ? T
    : never
  : never => (tenant.agent.kind === "chat" ? tenant.agent.contracts.flatMap((c) => c.tools) : []);

const versionRulesHaveAField = (tenant: Draft): boolean => {
  const { agent } = tenant;
  if (agent.kind !== "chat" || agent.systems.every((rule) => rule.versionAtLeast === undefined)) {
    return true;
  }
  return agent.context.some((field) => field.name === agent.versionField && field.kind === "text");
};

const serverToolsOnlyRead = (tenant: Draft): boolean =>
  toolsOf(tenant).every((tool) => tool.run.kind === "client" || tool.effect === "read");

const statelessToolsRunOnClient = (tenant: Draft): boolean =>
  tenant.agent.kind !== "chat" ||
  tenant.agent.state === "stored" ||
  toolsOf(tenant).every((tool) => tool.run.kind === "client");

const draftSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/),
  name: z.string().min(1).max(80),
  authn: authnSchema,
  plans: z.record(planId, planSchema).default({}),
  limits: limitsSchema,
  egress: z.object({ allowedHosts: z.array(hostname).max(20) }).default({ allowedHosts: [] }),
  knowledge: knowledgeSchema.optional(),
  evals: evalsSchema.optional(),
  messages: z.record(z.string().regex(/^[a-z_]{1,40}$/), shortText).default({}),
  agent: agentSchema,
});

export const tenantSchema = draftSchema
  .refine(versionRulesHaveAField, {
    message: "a system rule with versionAtLeast needs versionField to name a text context field",
    path: ["agent"],
  })
  .refine(
    (tenant) =>
      tenant.agent.kind !== "chat" ||
      tenant.agent.counting !== "questions_only" ||
      tenant.agent.state === "stored",
    {
      message: "questions_only counting needs a stored agent, where the runtime counts the rounds",
      path: ["agent"],
    },
  )
  .refine((tenant) => tenant.evals?.plan === undefined || tenant.evals.plan in tenant.plans, {
    message: "the eval plan must be defined in plans",
    path: ["evals"],
  })
  .refine(
    (tenant) =>
      tenant.evals === undefined ||
      tenant.authn.kind !== "app_attest" ||
      tenant.authn.storeEnvironment === "Sandbox",
    {
      message: "a tenant that serves production purchases cannot accept eval runs",
      path: ["evals"],
    },
  )
  .refine((tenant) => planNames(tenant).every((name) => name in tenant.plans), {
    message: "every plan named by the authenticator must be defined in plans",
    path: ["plans"],
  })
  .refine((tenant) => tenant.authn.kind === "anonymous" || Object.keys(tenant.plans).length > 0, {
    message: "an authenticated tenant needs at least one plan",
    path: ["plans"],
  })
  .refine((tenant) => tenant.authn.kind !== "anonymous" || tenant.agent.kind === "gated", {
    message: "an anonymous tenant can only run a gated agent",
    path: ["agent"],
  })
  .refine(httpToolsAllowed, {
    message: "every http tool must call a host listed in egress.allowedHosts",
    path: ["egress"],
  })
  .refine(hasUniqueVersions, { message: "contract versions must be unique", path: ["agent"] })
  .refine(serverToolsOnlyRead, {
    message: "a tool the runtime runs must have the read effect",
    path: ["agent"],
  })
  .refine(statelessToolsRunOnClient, {
    message: "a stateless agent can only have tools that run on the client",
    path: ["agent"],
  });

export type Tenant = z.infer<typeof tenantSchema>;
export type Authn = Tenant["authn"];
export type AppAttestAuthn = Extract<Authn, { kind: "app_attest" }>;
export type AccountTokenAuthn = Extract<Authn, { kind: "account_token" }>;
export type GatedAgent = Extract<Tenant["agent"], { kind: "gated" }>;
export type ChatAgent = Extract<Tenant["agent"], { kind: "chat" }>;
export type Contract = ChatAgent["contracts"][number];
export type ToolDefinition = Contract["tools"][number];
export type ContextField = ChatAgent["context"][number];
export type ChatInputLimits = ChatAgent["input"];
export type Gate = z.infer<typeof gateSchema>;
export type InputLimits = z.infer<typeof gatedInput>;
export type Plan = z.infer<typeof planSchema>;
export type Effort = z.infer<typeof effort>;
