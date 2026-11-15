const PRODUCTION_DEEPAI_API_ORIGIN = "https://api.deepai.org";

function isCanonicalLoopbackOrigin(origin: string): boolean {
  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(origin)) return false;
  try {
    const url = new URL(origin);
    return url.origin === origin && Number(url.port) <= 65535;
  } catch {
    return false;
  }
}

/** Local test routing is an explicit process opt-in, never a server-provided URL. */
export function resolveDeepAIApiOrigin(input: {
  readonly localTest: string | undefined;
  readonly origin: string | undefined;
}): string {
  if (input.origin === undefined && input.localTest !== "true") {
    return PRODUCTION_DEEPAI_API_ORIGIN;
  }
  if (input.localTest !== "true" || !input.origin || !isCanonicalLoopbackOrigin(input.origin)) {
    throw new Error(
      "Local DeepAI testing requires T3CODE_DEEPAI_LOCAL_TEST=true and a canonical http://127.0.0.1:port T3CODE_DEEPAI_DEV_API_ORIGIN.",
    );
  }
  return input.origin;
}
