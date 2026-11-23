import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export interface RuntimeOptions {
  providerUrl: string;
  adminToken: string;
}

export interface Runtime {
  url: string;
  stop: () => Promise<void>;
}

const READY_TIMEOUT_MS = 60_000;
const POLL_MS = 250;

const freePort = async (): Promise<number> =>
  new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => {
        resolve(port);
      });
    });
  });

const isHealthy = async (url: string): Promise<boolean> => {
  try {
    return (await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
};

const waitUntilReady = async (
  url: string,
  child: ChildProcess,
  output: string[],
): Promise<void> => {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`wrangler dev exited early:\n${output.join("")}`);
    }
    if (await isHealthy(url)) {
      return;
    }
    await sleep(POLL_MS);
  }
  throw new Error(`wrangler dev did not become ready:\n${output.join("")}`);
};

const stopChild = async (child: ChildProcess): Promise<void> =>
  new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => {
      resolve();
    });
    if (child.pid !== undefined) {
      process.kill(-child.pid, "SIGTERM");
    }
  });

export const startRuntime = async (options: RuntimeOptions): Promise<Runtime> => {
  const port = await freePort();
  const inspectorPort = await freePort();
  const state = await mkdtemp(join(tmpdir(), "ai-platform-e2e-"));
  const child = spawn(
    process.execPath,
    [
      "node_modules/wrangler/bin/wrangler.js",
      "dev",
      "--port",
      String(port),
      "--inspector-port",
      String(inspectorPort),
      "--persist-to",
      state,
      "--show-interactive-dev-session=false",
      "--var",
      "ANTHROPIC_API_KEY:e2e-key",
      "--var",
      `ANTHROPIC_BASE_URL:${options.providerUrl}`,
      "--var",
      `ADMIN_TOKEN:${options.adminToken}`,
      "--var",
      `EMBEDDINGS_BASE_URL:${options.providerUrl}`,
      "--var",
      "EMBEDDINGS_API_KEY:e2e-embeddings-key",
    ],
    {
      env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  const output: string[] = [];
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  const url = `http://127.0.0.1:${String(port)}`;
  await waitUntilReady(url, child, output);
  return {
    url,
    stop: async () => {
      await stopChild(child);
      await rm(state, { recursive: true, force: true });
    },
  };
};
