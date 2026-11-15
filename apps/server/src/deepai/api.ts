// @effect-diagnostics nodeBuiltinImport:off - This module is the raw wire boundary: lane headers, api-key digests, and the Linux proxy dispatcher stay synchronous Node calls.
// @effect-diagnostics globalFetch:off - Requests run inside the loopback transport's promise handlers, which hold no Effect runtime.
import * as NodeCrypto from "node:crypto";
import * as NodeProcess from "node:process";
import * as NodeModule from "node:module";

import packageJson from "../../package.json" with { type: "json" };

import { resolveDeepAIApiOrigin } from "./apiOrigin.ts";
import { deepAIMachineHeaders } from "./machineId.ts";

/** DeepAI's public wire formats; provider runtimes remain outside this boundary. */
const DEEPAI_API_ORIGIN = resolveDeepAIApiOrigin({
  localTest: NodeProcess.env.T3CODE_DEEPAI_LOCAL_TEST,
  origin: NodeProcess.env.T3CODE_DEEPAI_DEV_API_ORIGIN,
});
export const DEEPAI_MODEL_BASE = `${DEEPAI_API_ORIGIN}/deepai_code`;

const requireProxyTransport = NodeModule.createRequire(import.meta.url);
let proxyDispatcher: unknown;
export async function fetchDeepAI(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> {
  const env = NodeProcess.env;
  if (
    NodeProcess.platform === "linux" &&
    env.NODE_USE_ENV_PROXY !== "0" &&
    (env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY)
  ) {
    const origin = new URL(input instanceof Request ? input.url : input).origin;
    if (origin === "https://api.deepai.org" || origin === "https://deepai.org") {
      if (!proxyDispatcher) {
        const { Dispatcher1Wrapper, EnvHttpProxyAgent } = requireProxyTransport("undici") as {
          Dispatcher1Wrapper: new (dispatcher: unknown) => unknown;
          EnvHttpProxyAgent: new () => unknown;
        };
        proxyDispatcher = new Dispatcher1Wrapper(new EnvHttpProxyAgent());
      }
      const dispatcher = proxyDispatcher;
      return fetch(input, { ...init, dispatcher } as RequestInit);
    }
  }
  return fetch(input, init);
}

export const DEEPAI_LANE_HEADERS = {
  "X-DeepAI-Code-Theos": "6",
  "X-DeepAI-Code-Instance": NodeCrypto.randomBytes(16).toString("hex"),
} as const;
export const DEEPAI_CHECK_IN_HEADER = "X-DeepAI-Code-Check-In";
export const DEEPAI_BEACON_HEADER = "X-DeepAI-Code-Beacon";

/** The check-in a /theos answer carries (on a refusal too), or null when it carries none. */
export interface DeepAICheckIn {
  readonly nonce: string;
  readonly seconds: number;
}
export function readDeepAICheckIn(payload: unknown): DeepAICheckIn | null {
  const value = (payload as { check_in?: unknown } | null | undefined)?.check_in;
  return typeof (value as { nonce?: unknown } | undefined)?.nonce === "string" &&
    /^[0-9a-f]{32}$/.test((value as { nonce: string }).nonce) &&
    typeof (value as { seconds?: unknown } | undefined)?.seconds === "number" &&
    (value as { seconds: number }).seconds > 0
    ? {
        nonce: (value as { nonce: string }).nonce,
        seconds: (value as { seconds: number }).seconds,
      }
    : null;
}

/** What the app says about itself on each check-in; unknown facts are left out. */
export function deepAIBeacon(input: {
  readonly piActive: boolean | null;
  readonly focused: boolean | null;
}): string {
  return [
    `v=${packageJson.version}`,
    `up=${Math.floor(NodeProcess.uptime())}`,
    ...(input.piActive === null ? [] : [`pi=${input.piActive ? 1 : 0}`]),
    ...(input.focused === null ? [] : [`focus=${input.focused ? 1 : 0}`]),
  ].join(";");
}

export const deepAIAccountId = (apiKey: string): string =>
  NodeCrypto.createHash("sha256").update(apiKey).digest("hex");

// @effect-diagnostics-next-line extendsNativeError:off - Thrown across the transport's promise boundary, never through an Effect failure channel.
export class DeepAIHttpStatusError extends Error {
  readonly status: number;
  /** The JSON the refusal carried, when it carried any. */
  readonly body: unknown;
  constructor(status: number, body: unknown) {
    super("DeepAI request failed.");
    this.name = "DeepAIHttpStatusError";
    this.status = status;
    this.body = body;
  }
}

export async function requestDeepAIJson(
  path: string,
  apiKey: string | null,
  signal: AbortSignal,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<unknown> {
  const response = await fetchDeepAI(
    path === "/gravity-display-proxy" || path === "/get_usage_summary"
      ? `${DEEPAI_API_ORIGIN}${path}`
      : `${DEEPAI_MODEL_BASE}${path}`,
    {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        ...DEEPAI_LANE_HEADERS,
        ...(await deepAIMachineHeaders()),
        ...(apiKey ? { "Api-Key": apiKey } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal,
    },
  );
  if (!response.ok) {
    throw new DeepAIHttpStatusError(response.status, await response.json().catch(() => undefined));
  }
  if (path === "/session_turn" && (response.status === 202 || response.status === 204)) {
    return undefined;
  }
  return response.json();
}

const THEOS_AMOUNT = /^\d+(?:\.\d+)?$/;
export function isTheosAmount(value: unknown): value is string {
  return typeof value === "string" && THEOS_AMOUNT.test(value) && Number.isFinite(Number(value));
}

/** The lane version this build bills under. */
export const DEEPAI_LANE_VERSION = Number(DEEPAI_LANE_HEADERS["X-DeepAI-Code-Theos"]);

export interface DeepAIModel {
  readonly id: string;
  readonly name: string;
  readonly reasoning: boolean;
  readonly input: ReadonlyArray<"text" | "image">;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly premier?: boolean;
  readonly api?: "openai-responses";
  readonly theosPerRequest?: string;
  readonly theosPerSecond?: Record<string, string>;
}

export const BUNDLED_DEEPAI_MODELS: ReadonlyArray<DeepAIModel> = [
  {
    id: "glm-5.3-flash",
    name: "GLM 5.3 Flash",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 131072,
  },
];

export function decodeDeepAIModels(value: unknown): ReadonlyArray<DeepAIModel> {
  const list = (value as { models?: unknown } | null | undefined)?.models;
  if (!Array.isArray(list) || list.length === 0 || list.length > 100) {
    throw new Error("Invalid DeepAI model catalog.");
  }
  const ids = new Set<string>();
  const available = (list as Array<Record<string, unknown>>)
    .map((m) => {
      if (
        !m ||
        typeof m.id !== "string" ||
        !/^[a-zA-Z0-9_.-]{1,128}$/.test(m.id) ||
        ids.has(m.id) ||
        typeof m.name !== "string" ||
        !m.name.trim() ||
        m.name.length > 100 ||
        typeof m.reasoning !== "boolean" ||
        !Array.isArray(m.input) ||
        !m.input.includes("text") ||
        m.input.some((x: unknown) => x !== "text" && x !== "image") ||
        !Number.isSafeInteger(m.contextWindow) ||
        !Number.isSafeInteger(m.maxTokens) ||
        (m.contextWindow as number) <= 0 ||
        (m.maxTokens as number) <= 0 ||
        (m.maxTokens as number) > (m.contextWindow as number) ||
        (m.premier !== undefined && typeof m.premier !== "boolean") ||
        (m.api !== undefined && m.api !== "openai-responses") ||
        (m.theosPerRequest !== undefined && !isTheosAmount(m.theosPerRequest)) ||
        (m.theosPerSecond !== undefined &&
          (!m.theosPerSecond ||
            typeof m.theosPerSecond !== "object" ||
            Array.isArray(m.theosPerSecond) ||
            Object.entries(m.theosPerSecond).some(
              ([level, rate]) =>
                !["none", "low", "medium", "high"].includes(level) || !isTheosAmount(rate),
            )))
      ) {
        throw new Error("Invalid DeepAI model catalog.");
      }
      ids.add(m.id);
      return {
        id: m.id,
        name:
          m.id === "deepseek-v4.1-flash" && m.name === "DeepSeek V4.1 Flash"
            ? "DeepSeek V4.1 Flash 1017"
            : (m.name as string),
        reasoning: m.reasoning as boolean,
        input: m.input as ReadonlyArray<"text" | "image">,
        contextWindow: m.contextWindow as number,
        maxTokens: m.maxTokens as number,
        ...(m.premier === undefined ? {} : { premier: m.premier as boolean }),
        ...(m.api ? { api: m.api as "openai-responses" } : {}),
        ...(m.theosPerRequest === undefined
          ? {}
          : { theosPerRequest: m.theosPerRequest as string }),
        ...(m.theosPerSecond ? { theosPerSecond: { ...(m.theosPerSecond as object) } } : {}),
      } as DeepAIModel;
    })
    .filter((model) => model.id !== "gpt-oss-120b");
  if (available.length === 0) throw new Error("Invalid DeepAI model catalog.");
  return available;
}

export function deepAISignInUrl(state: string, port: number): string {
  const url = new URL("/deepai_code/desktop_auth/", DEEPAI_API_ORIGIN);
  url.search = new URLSearchParams({ state, port: String(port) }).toString();
  return url.href;
}

/** Only fixed, credential-free messages from the sign-in boundary reach the UI. */
// @effect-diagnostics-next-line extendsNativeError:off - Thrown across the sign-in listener's promise boundary, never through an Effect failure channel.
export class DeepAISignInError extends Error {}

function failedBeforeSignInPost(cause: unknown): boolean {
  if (cause instanceof AggregateError) {
    return cause.errors.length > 0 && cause.errors.every(failedBeforeSignInPost);
  }
  if (!(cause instanceof Error) || !("code" in cause)) return false;
  if (cause.code === "ETIMEDOUT") return "syscall" in cause && cause.syscall === "connect";
  return [
    "EAI_AGAIN",
    "UND_ERR_CONNECT_TIMEOUT",
    "ECONNREFUSED",
    "ENETUNREACH",
    "EHOSTUNREACH",
  ].includes(String(cause.code));
}

export interface DeepAICredentials {
  readonly apiKey: string;
  readonly username: string;
  readonly isPro: boolean;
}

export async function exchangeDeepAICode(
  code: string,
  signal: AbortSignal,
  request: typeof fetchDeepAI = fetchDeepAI,
): Promise<DeepAICredentials> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
  const exchange = () =>
    request(`${DEEPAI_MODEL_BASE}/desktop_auth/exchange/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
      redirect: "error",
      signal: deadline,
    });
  const response = await exchange()
    .catch((error) => {
      const cause = error instanceof Error ? error.cause : undefined;
      if (!deadline.aborted && failedBeforeSignInPost(cause)) return exchange();
      throw error;
    })
    .catch((error) => {
      const cause = error instanceof Error ? error.cause : undefined;
      if (
        cause &&
        typeof cause === "object" &&
        "code" in cause &&
        [
          "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
          "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
          "DEPTH_ZERO_SELF_SIGNED_CERT",
          "SELF_SIGNED_CERT_IN_CHAIN",
        ].includes(String(cause.code))
      ) {
        throw new DeepAISignInError(
          "DeepAI Code could not verify the network certificate. If you use a work proxy, check that its certificate is trusted on this computer, then start sign-in again.",
        );
      }
      throw new DeepAISignInError(
        "Could not reach DeepAI to finish signing in. Check your connection, then start sign-in again.",
      );
    });
  if (!response.ok) {
    throw new DeepAISignInError(
      response.status === 400 || response.status === 401
        ? "This sign-in link expired or was already used. Start sign-in again in the app."
        : response.status === 429
          ? "Too many sign-in attempts. Wait a moment, then start sign-in again."
          : "DeepAI could not finish signing in right now. Please try again shortly.",
    );
  }
  const d = (await response.json().catch(() => {
    throw new DeepAISignInError(
      "DeepAI returned an invalid sign-in response. Please start sign-in again.",
    );
  })) as { api_key?: unknown; username?: unknown; is_pro?: unknown } | null;
  if (!d || typeof d.api_key !== "string" || !d.api_key || /[\r\n]/.test(d.api_key)) {
    throw new DeepAISignInError("Invalid DeepAI sign-in response. Please start sign-in again.");
  }
  return {
    apiKey: d.api_key,
    username: typeof d.username === "string" ? d.username : "",
    isPro: d.is_pro === true,
  };
}

export function deepAIPiModels(
  baseUrl: string,
  capability: string,
  models: ReadonlyArray<DeepAIModel>,
): { providers: { deepai: Record<string, unknown> } } {
  return {
    providers: {
      deepai: {
        baseUrl,
        api: "openai-completions",
        apiKey: capability,
        compat: {
          supportsDeveloperRole: false,
          sendSessionAffinityHeaders: true,
        },
        models: models.map((m) => ({
          ...m,
          ...(m.reasoning
            ? {
                thinkingLevelMap: {
                  off: "none",
                  ...(m.id === "deepai-cyber" || m.id === "muse-ember" ? { max: "max" } : {}),
                  ...(m.id === "muse-ember" ? { xhigh: "xhigh" } : {}),
                },
              }
            : {}),
        })),
      },
    },
  };
}
