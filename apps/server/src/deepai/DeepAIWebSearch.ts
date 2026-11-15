import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { DeepAIAccountError } from "./errors.ts";

/** Minimal account surface a tool needs: authenticated JSON calls over the lane boundary. */
export interface DeepAIToolApi {
  readonly api: (path: string, body?: unknown) => Effect.Effect<unknown, DeepAIAccountError>;
}

export interface DeepAIToolResult {
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
  readonly details: Record<string, unknown>;
}

const DeepAIWebSearchInput = Schema.Struct({
  query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(800)),
  num_results: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 5 })),
  ),
});

const SearchResponse = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(32_000)),
  sources: Schema.Array(
    Schema.Struct({
      title: Schema.String.check(Schema.isMaxLength(300)),
      url: Schema.String.check(Schema.isMaxLength(2048)),
    }),
  ).check(Schema.isMaxLength(5)),
});

const decodeInput = Schema.decodeUnknownEffect(DeepAIWebSearchInput);
const decodeSearchResponse = Schema.decodeUnknownEffect(SearchResponse);

/** Managed Pi extension hook: execute(input) -> inert tool result. Account.api
 * fixes the upstream origin, attaches auth/Theos headers, aborts on account
 * change, and rejects responses from the previous account. Never use the
 * cloud-sync-gated apiForAccount here: search works with history sync off. */
export function makeDeepAIWebSearch(
  account: DeepAIToolApi,
): (input: unknown) => Effect.Effect<DeepAIToolResult, DeepAIAccountError> {
  return (input) =>
    Effect.gen(function* () {
      const request = yield* decodeInput(input).pipe(
        Effect.mapError(
          (cause) => new DeepAIAccountError({ operation: "web search input", cause }),
        ),
      );
      if (!request.query.trim()) {
        return yield* new DeepAIAccountError({
          operation: "web search input",
          cause: "Empty query",
        });
      }
      const raw = yield* account.api("/web_search", {
        query: request.query.trim(),
        num_results: request.num_results ?? 5,
      });
      const response = yield* decodeSearchResponse(raw).pipe(
        Effect.mapError(
          (cause) => new DeepAIAccountError({ operation: "web search response", cause }),
        ),
      );
      for (const source of response.sources) {
        const url = yield* Effect.try({
          try: () => new URL(source.url),
          catch: () =>
            new DeepAIAccountError({ operation: "web search source", cause: "Invalid URL" }),
        });
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
          return yield* new DeepAIAccountError({
            operation: "web search source",
            cause: "Invalid URL",
          });
        }
      }
      return {
        content: [{ type: "text" as const, text: response.text || "No results." }],
        details: { sources: response.sources },
      };
    });
}
