#!/usr/bin/env node
/**
 * Standalone DeepAI ACP agent: pi-acp over a DeepAI-managed pi home; the loopback
 * transport holds the real API key and pi only sees a per-boot capability token.
 * `deepai-acp login` runs the browser sign-in; bare `deepai-acp` is the ACP stdio mode
 * T3 Code spawns. 独立 DeepAI ACP 代理：login 走浏览器登录，无参模式由 T3 Code 拉起。
 */

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  BUNDLED_DEEPAI_MODELS,
  DEEPAI_CHECK_IN_HEADER,
  decodeDeepAIModels,
  deepAIPiModels,
  readDeepAICheckIn,
  requestDeepAIJson,
  type DeepAICredentials,
  type DeepAIModel,
} from "../src/deepai/api.ts";
import { startDeepAIModelTransport, startDeepAISignIn } from "../src/deepai/localTransport.ts";
import { isDeepAIModelMetered } from "../src/deepai/modelRates.ts";

const HOME_DIR = NodePath.join(NodeOS.homedir(), ".deepai-acp");
const PI_DIR = NodePath.join(HOME_DIR, "pi");
const CREDENTIALS_PATH = NodePath.join(HOME_DIR, "credentials.json");
const CATALOG_PATH = NodePath.join(HOME_DIR, "models-cache.json");

const readCredentials = async (): Promise<DeepAICredentials | null> => {
  try {
    const raw = JSON.parse(
      await NodeFSP.readFile(CREDENTIALS_PATH, "utf8"),
    ) as Partial<DeepAICredentials>;
    return typeof raw.apiKey === "string" && raw.apiKey
      ? {
          apiKey: raw.apiKey,
          username: typeof raw.username === "string" ? raw.username : "",
          isPro: raw.isPro === true,
        }
      : null;
  } catch {
    return null;
  }
};

const writeCredentials = async (credentials: DeepAICredentials) => {
  await NodeFSP.mkdir(HOME_DIR, { recursive: true, mode: 0o700 });
  await NodeFSP.writeFile(CREDENTIALS_PATH, `${JSON.stringify(credentials, null, 2)}\n`, {
    mode: 0o600,
  });
};

/** /theos heartbeat: renews the billing mark before each hosted-model turn. */
const makeEnsureCheckedIn = () => {
  let mark: { nonce: string; seconds: number } | null = null;
  let markAt = -Infinity;
  let chain: Promise<unknown> = Promise.resolve();
  return (signal: AbortSignal): Promise<void> => {
    const run = async () => {
      const credentials = await readCredentials();
      if (!credentials || signal.aborted) return;
      if (mark && Date.now() - markAt < (mark.seconds * 1e3) / 2) return;
      const result = await requestDeepAIJson(
        "/theos",
        credentials.apiKey,
        signal,
        undefined,
        mark ? { [DEEPAI_CHECK_IN_HEADER]: mark.nonce } : undefined,
      );
      const next = readDeepAICheckIn(result);
      if (!next) throw new Error("The server did not return a check-in.");
      mark = next;
      markAt = Date.now();
    };
    chain = chain.then(run, run);
    return chain.then(() => {});
  };
};

const fetchCatalog = async (): Promise<ReadonlyArray<DeepAIModel>> => {
  const credentials = await readCredentials();
  if (credentials) {
    try {
      const models = decodeDeepAIModels(
        await requestDeepAIJson("/models", credentials.apiKey, AbortSignal.timeout(8_000)),
      );
      await NodeFSP.writeFile(CATALOG_PATH, JSON.stringify(models), { mode: 0o600 }).catch(
        () => {},
      );
      return models;
    } catch {}
  }
  try {
    return decodeDeepAIModels(JSON.parse(await NodeFSP.readFile(CATALOG_PATH, "utf8")));
  } catch {
    return BUNDLED_DEEPAI_MODELS;
  }
};

/** Atomic pi-home write; pi restarts pick it up on the next session. */
const writePiHome = async (
  baseUrl: string,
  capability: string,
  models: ReadonlyArray<DeepAIModel>,
) => {
  await NodeFSP.mkdir(PI_DIR, { recursive: true, mode: 0o700 });
  const write = async (name: string, content: unknown) => {
    const temporary = NodePath.join(
      PI_DIR,
      `${name}.tmp-${NodeCrypto.randomBytes(4).toString("hex")}`,
    );
    await NodeFSP.writeFile(temporary, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 });
    await NodeFSP.rename(temporary, NodePath.join(PI_DIR, name));
  };
  await write("models.json", deepAIPiModels(baseUrl, capability, models));
  await write("settings.json", { retry: { enabled: true, maxRetries: 5, baseDelayMs: 5000 } });
};

const login = async () => {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  const transport = await startDeepAIModelTransport({ readCredentials });
  try {
    const signIn = await startDeepAISignIn({
      confirmationUrl: transport.newSignInConfirmationUrl(),
      signal: controller.signal,
      save: async (credentials) => {
        await writeCredentials(credentials);
      },
    });
    console.log(`Sign in to DeepAI in your browser:\n\n  ${signIn.url}\n`);
    NodeChildProcess.spawn("open", [signIn.url], { stdio: "ignore" }).unref();
    await signIn.done;
    const credentials = await readCredentials();
    console.log(
      `Signed in to DeepAI${credentials?.username ? ` as ${credentials.username}` : ""}.`,
    );
    signIn.close();
  } finally {
    transport.close();
  }
};

const agent = async () => {
  const catalog = await fetchCatalog();
  const transport = await startDeepAIModelTransport({
    readCredentials,
    metered: (model) => isDeepAIModelMetered(catalog, model),
    ensureCheckedIn: makeEnsureCheckedIn(),
  });
  await writePiHome(transport.baseUrl, transport.capability, catalog);

  const child = NodeChildProcess.spawn("pi-acp", [], {
    stdio: "inherit",
    env: { ...process.env, PI_CODING_AGENT_DIR: PI_DIR },
  });
  const shutdown = () => child.kill("SIGTERM");
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  child.once("exit", (code, signal) => {
    transport.close();
    process.exit(code ?? (signal ? 1 : 0));
  });
};

const mode = process.argv[2] === "login" ? "login" : "agent";
try {
  if (mode === "login") {
    await login();
  } else {
    await agent();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
