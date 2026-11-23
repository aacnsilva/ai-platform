import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { CLIENT_TOOLS, createChatTenant, serverTools } from "./support/chat.ts";
import { adminGet, createTenant, eventually, providerCalls, runtimeUrl } from "./support/client.ts";

type Json = Record<string, unknown>;

const SECRET = "eval-secret-for-the-end-to-end-suite-0123456789";
const EVALS = { secretSha256: createHash("sha256").update(SECRET).digest("hex") };

interface Sent {
  status: number;
  body: {
    error?: string;
    answer?: string;
    eval?: { model: string; modelCalls: number; costNanoEur: number };
  };
}

const ask = async (
  tenant: string,
  headers: Record<string, string>,
  question = "EVALQ hello",
): Promise<Sent> => {
  const response = await fetch(`${runtimeUrl()}/v1/tenants/${tenant}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ messages: [{ role: "user", content: question }] }),
  });
  return { status: response.status, body: (await response.json()) as Sent["body"] };
};

const evalHeaders = (run: string, extra: Record<string, string> = {}): Record<string, string> => ({
  "x-eval-secret": SECRET,
  "x-eval-run": run,
  ...extra,
});

interface Ran {
  code: number | null;
  output: string;
}

const runEvals = async (args: string[]): Promise<Ran> =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "evals/run.ts", ...args], {
      cwd: join(import.meta.dirname, ".."),
      env: { ...process.env, EVAL_SECRET: SECRET },
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("exit", (code) => {
      resolve({ code, output });
    });
  });

describe("the eval pass", () => {
  let tenant = "";

  beforeAll(async () => {
    tenant = await createTenant({
      limits: { ipPerHour: 1 },
      extra: { evals: { ...EVALS, tiers: ["balanced"] } },
    });
  });

  it("lets a runner in without an origin or a network limit, and reports what each call cost", async () => {
    for (const run of ["run-1", "run-2", "run-3"]) {
      const sent = await ask(tenant, evalHeaders(run));
      expect(sent.status).toBe(200);
      expect(sent.body.eval).toMatchObject({ model: "claude-haiku-5-5", modelCalls: 1 });
      expect(sent.body.eval?.costNanoEur).toBeGreaterThan(0);
    }
  });

  it("refuses a wrong secret and a run without a name", async () => {
    const wrong = await ask(tenant, { "x-eval-secret": "x".repeat(40), "x-eval-run": "run-1" });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toBe("bad_eval_secret");
    expect((await ask(tenant, { "x-eval-secret": SECRET })).body.error).toBe("missing_eval_run");
  });

  it("gives ordinary callers no trace, and ignores the header on a tenant without evals", async () => {
    const plain = await createTenant();
    const ordinary = await ask(plain, { origin: "http://localhost:8080" });
    expect(ordinary.body.eval).toBeUndefined();
    const ignored = await ask(plain, evalHeaders("run-1"));
    expect(ignored.status).toBe(200);
    expect(ignored.body.eval).toBeUndefined();
  });

  it("grades another model tier only when the tenant allows that tier for evals", async () => {
    await ask(tenant, evalHeaders("tier-1", { "x-eval-tier": "balanced" }), "TIERPROBE allowed");
    const strict = await createTenant({ extra: { evals: EVALS } });
    await ask(strict, evalHeaders("tier-2", { "x-eval-tier": "balanced" }), "TIERPROBE refused");
    const models = (await providerCalls())
      .filter((call) => call.question.startsWith("TIERPROBE"))
      .map((call) => `${call.question}: ${call.model}`);
    expect(models).toEqual([
      "TIERPROBE allowed: claude-sonnet-5-5",
      "TIERPROBE refused: claude-haiku-5-5",
    ]);
  });

  it("cannot be switched on for a tenant that serves production purchases", async () => {
    const production = await createChatTenant({
      state: "stateless",
      tools: CLIENT_TOOLS,
      plans: { plus: { messagesPerMonth: 3 } },
      authn: {
        kind: "app_attest",
        teamId: "ABCDE12345",
        bundleId: "com.example.app",
        storeEnvironment: "Production",
        products: { "example.plan.monthly": "plus" },
      },
      extra: { evals: EVALS },
    });
    expect(production.status).toBe(400);
    expect(String(production.body["message"])).toContain("cannot accept eval runs");
  });

  it("marks eval traffic so the dashboard can leave it out", async () => {
    const fresh = await createTenant({ extra: { evals: EVALS } });
    await ask(fresh, evalHeaders("metrics-1"));
    await ask(fresh, { origin: "http://localhost:8080" });
    const count = async (traffic: string): Promise<number> => {
      const response = await adminGet(
        `/admin/api/metrics?hours=1&tenant=${fresh}&traffic=${traffic}`,
      );
      return ((await response.json()) as { totals: { requests: number } }).totals.requests;
    };
    await eventually(
      async () => count(""),
      (requests) => requests >= 2,
    );
    expect([await count(""), await count("real"), await count("evals")]).toEqual([2, 1, 1]);
  });
});

describe("the eval runner", () => {
  let folder = "";
  const suiteFile = async (name: string, suite: Json): Promise<string> => {
    const path = join(folder, name);
    await writeFile(path, JSON.stringify(suite));
    return path;
  };
  const latest = async (): Promise<Json> =>
    JSON.parse(await readFile(join(folder, "results", "latest.json"), "utf8")) as Json;

  beforeAll(async () => {
    folder = await mkdtemp(join(tmpdir(), "ai-platform-evals-"));
  });

  it("grades a gated tenant, names what failed, and exits non-zero", async () => {
    const tenant = await createTenant({ extra: { evals: EVALS } });
    const cases = await suiteFile("gated.json", {
      version: 1,
      agent: "gated",
      cases: [
        {
          id: "answers",
          group: "help",
          questions: ["Does it cost 4.00 a month"],
          expect: { onTopic: true, amounts: ["4"] },
        },
        {
          id: "refuses",
          group: "out-of-scope",
          questions: ["OFFTOPIC a joke"],
          expect: { onTopic: false, contains: ["only answer questions about Lumen"] },
        },
        {
          id: "wrongly-expected",
          group: "help",
          questions: ["hello there"],
          expect: { contains: ["a word the answer lacks"] },
        },
      ],
    });
    const ran = await runEvals(["--runtime", runtimeUrl(), "--tenant", tenant, "--cases", cases]);
    expect(ran.code).toBe(1);
    expect(ran.output).toContain("help                 1/2");
    expect(ran.output).toContain('FAIL wrongly-expected: answer lacks "a word the answer lacks"');
    const summary = await latest();
    expect(summary).toMatchObject({ cases: 3, passed: 2, errors: 0, modelCalls: 3 });
    expect(Number(summary["costEur"])).toBeGreaterThan(0);
  });

  it("plays tool conversations on a stored tenant, answering client tools from the suite", async () => {
    const tenant = await createChatTenant({
      state: "stored",
      tools: serverTools(),
      extra: { evals: { ...EVALS, plan: "pro" } },
    });
    const cases = await suiteFile("stored.json", {
      version: 1,
      agent: "stored",
      context: { locale: "en" },
      toolResults: { show_card: "CARD-FROM-SUITE" },
      cases: [
        {
          id: "fetches",
          group: "tools",
          questions: ["TOOLCALL get_guide slug=intro"],
          expect: {
            tools: ["get_guide"],
            calls: [{ tool: "get_guide", times: 1, input: { slug: "intro" } }],
            noCalls: [{ tool: "show_card" }],
            contains: ["MARKER-GUIDE-INTRO"],
            maxModelCalls: 2,
          },
        },
        {
          id: "client-tool",
          group: "tools",
          questions: ["TOOLCALL show_card title=Hi"],
          expect: {
            calls: [{ tool: "show_card", input: { title: "Hi" } }],
            contains: ["CARD-FROM-SUITE"],
            stopReason: "end_turn",
            grounded: true,
          },
        },
        {
          id: "no-tool",
          group: "plain",
          questions: ["just talk", "and again"],
          expect: { noAnyTool: true, contains: ["and again"] },
        },
      ],
    });
    const base = ["--runtime", runtimeUrl(), "--tenant", tenant.id, "--cases", cases];
    const ran = await runEvals([...base, "--runs", "2", "--save-baseline"]);
    expect(ran.output).toContain("3/3 passed");
    expect(ran.code).toBe(0);
    const only = await runEvals([...base, "--only", "plain"]);
    expect(only.output).toContain("1/1 passed");
    expect(only.output).toContain("Against the baseline: 0 now failing, 0 now passing, 0 new.");
  });

  it("explains how to run it when something is missing", async () => {
    const ran = await runEvals(["--tenant", "x"]);
    expect(ran.code).toBe(2);
    expect(ran.output).toContain("Usage: EVAL_SECRET=");
  });
});
