// @effect-diagnostics nodeBuiltinImport:off - The loopback transport is a raw Node HTTP server with a timing-safe bearer check; it holds no Effect runtime.
// @effect-diagnostics globalTimers:off - Status-poll timers resolve through AbortSignals inside promise callbacks, not Effect-managed work.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeTimersPromises from "node:timers/promises";

import {
  DEEPAI_LANE_HEADERS,
  DEEPAI_MODEL_BASE,
  DeepAIHttpStatusError,
  DeepAISignInError,
  deepAISignInUrl,
  exchangeDeepAICode,
  fetchDeepAI,
  type DeepAICredentials,
} from "./api.ts";
import { deepAIMachineHeaders } from "./machineId.ts";
import { fetchWithDeepAIWatchdog, waitForDeepAICapacity } from "./modelTransportPolicy.ts";

const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && NodeCrypto.timingSafeEqual(x, y);
};

function listen(server: NodeHttp.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not bind local DeepAI transport."));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server: NodeHttp.Server) {
  server.closeAllConnections();
  server.close();
}

function fail(response: NodeHttp.ServerResponse, status: number, message: string) {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify({ error: { message, type: "deepai_connection_error" } }));
}

export interface DeepAITransportTool {
  (input: unknown, signal: AbortSignal): Promise<unknown>;
}

export interface DeepAIModelTransportInput {
  readonly readCredentials: () => Promise<DeepAICredentials | null>;
  readonly metered?: (model: string) => boolean;
  readonly webSearch?: DeepAITransportTool;
  readonly findService?: DeepAITransportTool;
  readonly ensureCheckedIn?: (signal: AbortSignal) => Promise<void>;
  readonly request?: typeof fetchDeepAI;
  readonly toolsOnly?: boolean;
}

export interface DeepAIModelTransport {
  readonly baseUrl: string;
  readonly capability: string;
  readonly newSignInConfirmationUrl: () => string;
  readonly cancelRequests: () => void;
  readonly close: () => void;
}

/** Loopback-only provider transport. DeepAI credentials never enter Pi's config or renderer. */
export async function startDeepAIModelTransport(
  input: DeepAIModelTransportInput,
): Promise<DeepAIModelTransport> {
  const capability = NodeCrypto.randomBytes(32).toString("hex");
  const requests = new Set<AbortController>();
  let slot: Promise<void> | null = null;
  const holdSlot = async (
    signal: AbortSignal,
    onWaiting: (waiting: boolean) => void,
  ): Promise<() => void> => {
    signal.throwIfAborted();
    let waited = false;
    for (;;) {
      if (slot === null) break;
      if (!waited) {
        waited = true;
        onWaiting(true);
      }
      const held = slot;
      await new Promise<void>((resolve) => {
        const done = () => {
          signal.removeEventListener("abort", done);
          resolve();
        };
        held.then(done, done);
        signal.addEventListener("abort", done, { once: true });
      });
      if (signal.aborted) {
        onWaiting(false);
        throw signal.reason;
      }
    }
    if (waited) onWaiting(false);
    let release!: () => void;
    slot = new Promise<void>((resolve) => {
      release = resolve;
    });
    return () => {
      slot = null;
      release();
    };
  };

  let signInCompletePath: string | null = null;
  const request = input.request ?? fetchDeepAI;
  const capacity = new Map<string, { waiting: number; version: number }>();
  const listeners = new Set<() => void>();
  const stateFor = (key: string) => capacity.get(key) ?? { waiting: 0, version: 0 };
  const setWaiting = (key: string, waiting: boolean) => {
    const previous = stateFor(key);
    const count = Math.max(0, previous.waiting + (waiting ? 1 : -1));
    capacity.delete(key);
    capacity.set(key, { waiting: count, version: previous.version + 1 });
    if (capacity.size > 512) {
      for (const [old, state] of capacity) {
        if (!state.waiting && old !== key) {
          capacity.delete(old);
          break;
        }
      }
    }
    for (const listener of listeners) listener();
  };
  const waitForStatus = (key: string, version: string | null, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (version !== String(stateFor(key).version) || signal.aborted) {
        resolve();
        return;
      }
      const finish = () => {
        clearTimeout(timer);
        listeners.delete(changed);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const changed = () => {
        if (version !== String(stateFor(key).version)) finish();
      };
      const timer = setTimeout(finish, 30_000);
      listeners.add(changed);
      signal.addEventListener("abort", finish, { once: true });
      if (signal.aborted) finish();
    });

  const server = NodeHttp.createServer((incoming, response) => {
    (async () => {
      const statusUrl = new URL(incoming.url ?? "/", "http://127.0.0.1");
      const path = statusUrl.pathname;
      if (!input.toolsOnly && incoming.method === "GET" && path === signInCompletePath) {
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
          "Referrer-Policy": "no-referrer",
        });
        response.end(
          "<h2>Signed in to DeepAI Code</h2><p>You can close this tab and return to the app.</p>",
        );
        return;
      }
      const isStatus = incoming.method === "GET" && path === "/model-status" && !input.toolsOnly;
      const tool =
        path === "/web_search"
          ? input.webSearch
          : path === "/find_service"
            ? input.findService
            : undefined;
      const isSearch = tool !== undefined;
      if (
        !isStatus &&
        (incoming.method !== "POST" ||
          (!isSearch &&
            (input.toolsOnly || (path !== "/chat/completions" && path !== "/responses"))))
      ) {
        fail(response, 404, "Unsupported model operation.");
        return;
      }
      if (
        incoming.headers.origin ||
        !sameSecret(incoming.headers.authorization ?? "", `Bearer ${capability}`)
      ) {
        fail(response, 403, "Model transport authentication required.");
        return;
      }
      const controller = new AbortController();
      requests.add(controller);
      response.once("close", () => controller.abort());
      controller.signal.addEventListener("abort", () => response.destroy(), { once: true });
      let releaseSlot = () => {};
      try {
        const credentials = await input.readCredentials();
        if (!credentials && !input.toolsOnly) {
          fail(response, 401, "Sign in to DeepAI Code before starting a hosted-model turn.");
          return;
        }
        if (isStatus) {
          const key = statusUrl.searchParams.get("thread") ?? "";
          if (!/^[A-Za-z0-9._:-]{1,256}$/.test(key)) {
            fail(response, 400, "Invalid chat identity.");
            return;
          }
          await waitForStatus(key, statusUrl.searchParams.get("after"), controller.signal);
          if (controller.signal.aborted) return;
          const state = stateFor(key);
          response.writeHead(200, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          });
          response.end(JSON.stringify({ waiting: state.waiting > 0, version: state.version }));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of incoming) {
          size += chunk.length;
          if (size > (isSearch ? 8_192 : 33_554_432)) {
            fail(response, 413, "Model request is too large.");
            return;
          }
          chunks.push(Buffer.from(chunk));
        }
        if (controller.signal.aborted) return;
        if (isSearch) {
          let searchInput: unknown;
          try {
            searchInput = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            fail(response, 400, "Invalid web search request.");
            return;
          }
          const result = await tool(searchInput, controller.signal);
          if (controller.signal.aborted) return;
          const body = JSON.stringify(result);
          if (Buffer.byteLength(body) > 262_144) {
            fail(response, 502, "Web search result is too large.");
            return;
          }
          response.writeHead(200, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          });
          response.end(body);
          return;
        }
        const affinity = incoming.headers["x-session-affinity"];
        const body = Buffer.concat(chunks);
        let threadKey: string | undefined;
        let model: string | undefined;
        try {
          const payload = JSON.parse(body.toString("utf8"));
          if (
            typeof payload.prompt_cache_key === "string" &&
            /^[A-Za-z0-9._:-]{1,256}$/.test(payload.prompt_cache_key)
          ) {
            threadKey = payload.prompt_cache_key;
          }
          if (typeof payload.model === "string") {
            model = payload.model.replace(/^deepai\//, "");
          }
        } catch {}
        const setThreadWaiting = (waiting: boolean) => {
          if (threadKey) setWaiting(threadKey, waiting);
        };
        if (model === undefined || (input.metered?.(model) ?? true)) {
          releaseSlot = await holdSlot(controller.signal, setThreadWaiting);
        }
        const machineHeaders = await deepAIMachineHeaders();
        const upstream = await waitForDeepAICapacity(
          async () => {
            try {
              await input.ensureCheckedIn?.(controller.signal);
            } catch (error) {
              controller.signal.throwIfAborted();
              const body = error instanceof DeepAIHttpStatusError ? error.body : undefined;
              if (
                error instanceof DeepAIHttpStatusError &&
                error.status >= 400 &&
                error.status < 500 &&
                typeof body === "object" &&
                body !== null &&
                "error" in body
              ) {
                return Response.json({ error: body.error }, { status: error.status });
              }
              return Response.json(
                {
                  error: {
                    message: "DeepAI could not renew this app’s connection. Please retry the turn.",
                    code: "check_in_unavailable",
                  },
                },
                { status: 503 },
              );
            }
            return fetchWithDeepAIWatchdog(request, `${DEEPAI_MODEL_BASE}${path}`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...DEEPAI_LANE_HEADERS,
                ...machineHeaders,
                "api-key": credentials!.apiKey,
                ...(typeof affinity === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(affinity)
                  ? { "X-Session-Affinity": affinity }
                  : {}),
              },
              body,
              redirect: "error",
              signal: controller.signal,
            });
          },
          controller.signal,
          setThreadWaiting,
        );
        response.writeHead(upstream.status, {
          "Content-Type": upstream.headers.get("content-type") ?? "application/json",
          ...(upstream.headers.has("retry-after")
            ? { "Retry-After": upstream.headers.get("retry-after")! }
            : {}),
          "Cache-Control": "no-store",
        });
        if (upstream.body) {
          for await (const chunk of upstream.body) {
            if (!response.write(chunk)) {
              await new Promise<void>((resolve) => {
                const resume = () => {
                  response.off("drain", resume);
                  response.off("close", resume);
                  resolve();
                };
                response.once("drain", resume);
                response.once("close", resume);
              });
            }
          }
        }
        response.end();
      } catch {
        fail(
          response,
          502,
          isSearch
            ? "DeepAI web search failed. Please try again."
            : "DeepAI model connection failed. No alternative provider was billed.",
        );
      } finally {
        releaseSlot();
        requests.delete(controller);
      }
    })().catch(() => fail(response, 502, "DeepAI model connection failed."));
  });

  const port = await listen(server);
  const cancelRequests = () => {
    for (const request of requests) request.abort();
  };
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    newSignInConfirmationUrl() {
      signInCompletePath = `/sign-in-complete/${NodeCrypto.randomUUID()}`;
      return `http://127.0.0.1:${port}${signInCompletePath}`;
    },
    capability,
    cancelRequests,
    close: () => {
      cancelRequests();
      close(server);
    },
  };
}

export interface DeepAISignInHandle {
  readonly url: string;
  readonly done: Promise<void>;
  readonly close: () => void;
}

/** A cancellable RFC 8252 callback; a stale/cancelled callback cannot save credentials. */
export async function startDeepAISignIn(input: {
  readonly confirmationUrl: string;
  readonly signal: AbortSignal;
  readonly save: (credentials: DeepAICredentials, signal: AbortSignal) => Promise<void>;
  readonly request?: typeof fetchDeepAI;
}): Promise<DeepAISignInHandle> {
  const lifetime = new AbortController();
  const signal = AbortSignal.any([input.signal, lifetime.signal]);
  const state = NodeCrypto.randomBytes(32).toString("hex");
  let exchangingCode: string | undefined;
  const signedIn = (response: NodeHttp.ServerResponse) => {
    response.writeHead(303, {
      Location: input.confirmationUrl,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    });
    response.end();
  };
  let resolveDone!: () => void;
  let rejectDone!: (error: unknown) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  done.catch(() => {});
  const server = NodeHttp.createServer((req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://127.0.0.1");
    } catch {
      fail(res, 400, "Invalid sign-in callback.");
      return;
    }
    if (url.pathname !== "/auth-callback") {
      fail(res, 404, "Not found.");
      return;
    }
    const code = url.searchParams.get("code");
    if (
      req.method !== "GET" ||
      signal.aborted ||
      !code ||
      code.length > 4096 ||
      !sameSecret(url.searchParams.get("state") ?? "", state)
    ) {
      fail(res, 400, "Invalid sign-in callback.");
      return;
    }
    if (exchangingCode !== undefined) {
      if (!sameSecret(code, exchangingCode)) {
        fail(res, 409, "Sign-in already in progress.");
      } else {
        done.then(
          () => signedIn(res),
          (error) =>
            fail(
              res,
              400,
              error instanceof DeepAISignInError
                ? error.message
                : "Sign-in did not complete. Return to the app and try again.",
            ),
        );
      }
      return;
    }
    exchangingCode = code;
    (async () => {
      try {
        const credentials = await exchangeDeepAICode(code, signal, input.request);
        if (signal.aborted) return;
        try {
          for (let attempt = 0; ; attempt++) {
            signal.throwIfAborted();
            try {
              await input.save(credentials, signal);
              break;
            } catch (error) {
              if (attempt === 2 || signal.aborted) throw error;
              await NodeTimersPromises.setTimeout(100 * (attempt + 1), undefined, {
                signal,
              });
            }
          }
        } catch {
          throw new DeepAISignInError(
            "Signed in with DeepAI, but the app could not save your account. Check that the app can write to its data folder, then try again.",
          );
        }
        if (signal.aborted) return;
        signedIn(res);
        resolveDone();
        server.close();
      } catch (error) {
        const failure =
          error instanceof DeepAISignInError
            ? error
            : new DeepAISignInError("Sign-in failed. Return to DeepAI Code and try again.");
        fail(res, 400, failure.message);
        rejectDone(failure);
        server.close();
      }
    })();
  });
  const cancel = () => {
    close(server);
    rejectDone(new Error("DeepAI sign-in cancelled."));
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const port = await listen(server);
    if (signal.aborted) cancel();
    return {
      url: deepAISignInUrl(state, port),
      done,
      close: () => {
        lifetime.abort();
        signal.removeEventListener("abort", cancel);
      },
    };
  } catch (error) {
    signal.removeEventListener("abort", cancel);
    close(server);
    throw error;
  }
}
