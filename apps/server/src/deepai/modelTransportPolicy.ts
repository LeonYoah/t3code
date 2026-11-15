// @effect-diagnostics globalTimers:off - Watchdog and retry timers live inside the transport's promise callbacks and resolve through AbortSignals.
const DEEPAI_IDLE_TIMEOUT_MS = 330_000;
const DEEPAI_REQUEST_TIMEOUT_MS = 930_000;

/** Capacity refusals are not model executions. Only the explicit admission code is retried. */
export async function waitForDeepAICapacity(
  request: () => Promise<Response>,
  signal: AbortSignal,
  onWaiting: (waiting: boolean) => void = () => {},
): Promise<Response> {
  let waiting = false;
  try {
    for (;;) {
      signal.throwIfAborted();
      const response = await request();
      if (response.status !== 409) return response;
      let busy = false;
      try {
        const body = await response.clone().json();
        busy =
          typeof body === "object" &&
          body !== null &&
          "error" in body &&
          typeof body.error === "object" &&
          body.error !== null &&
          "code" in body.error &&
          (body.error as { code: unknown }).code === "session_busy";
      } catch {}
      if (!busy) return response;
      if (!waiting) {
        waiting = true;
        onWaiting(true);
      }
      await response.body?.cancel();
      const retry = Number(response.headers.get("retry-after") ?? 2);
      const delay = Number.isFinite(retry) ? Math.min(30, Math.max(1, retry)) : 2;
      await new Promise<void>((resolve, reject) => {
        const cancel = () => {
          clearTimeout(timer);
          reject(signal.reason);
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", cancel);
          resolve();
        }, delay * 1000);
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
      });
    }
  } finally {
    if (waiting) onWaiting(false);
  }
}

/** Liveness follows actual incoming bytes, including SSE keepalives, rather than UI events. */
export async function fetchWithDeepAIWatchdog(
  request: (url: string, init: RequestInit) => Promise<Response>,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const timeout = new AbortController();
  const signal = AbortSignal.any([init.signal ?? new AbortController().signal, timeout.signal]);
  const expired = () => timeout.abort(new Error("Model response timed out."));
  let idle = setTimeout(expired, DEEPAI_IDLE_TIMEOUT_MS);
  const overall = setTimeout(expired, DEEPAI_REQUEST_TIMEOUT_MS);
  const cleanup = () => {
    clearTimeout(idle);
    clearTimeout(overall);
  };
  signal.addEventListener("abort", cleanup, { once: true });
  try {
    const response = await request(url, { ...init, signal });
    if (signal.aborted) {
      await response.body?.cancel(signal.reason);
      signal.throwIfAborted();
    }
    if (!response.body) {
      cleanup();
      signal.removeEventListener("abort", cleanup);
      return response;
    }
    const reader = response.body.getReader();
    const stop = () => {
      reader.cancel(signal.reason).catch(() => {});
    };
    signal.addEventListener("abort", stop, { once: true });
    const finish = () => {
      cleanup();
      signal.removeEventListener("abort", stop);
      signal.removeEventListener("abort", cleanup);
    };
    return new Response(
      new ReadableStream({
        async pull(controller) {
          try {
            signal.throwIfAborted();
            const result = await reader.read();
            signal.throwIfAborted();
            if (result.done) {
              finish();
              controller.close();
              return;
            }
            clearTimeout(idle);
            idle = setTimeout(expired, DEEPAI_IDLE_TIMEOUT_MS);
            controller.enqueue(result.value);
          } catch (error) {
            finish();
            controller.error(error);
          }
        },
        async cancel(reason) {
          finish();
          await reader.cancel(reason);
        },
      }),
      {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      },
    );
  } catch (error) {
    cleanup();
    signal.removeEventListener("abort", cleanup);
    throw error;
  }
}
