import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { DeepAIAccountError } from "./errors.ts";
import type { DeepAIToolApi, DeepAIToolResult } from "./DeepAIWebSearch.ts";

const FindServiceInput = Schema.Struct({
  query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_000)),
  context: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  search_id: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
});

const FindServiceOutput = Schema.Struct({
  text: Schema.optional(Schema.String.check(Schema.isMaxLength(32_000))),
  name: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(300)))),
  click_url: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(4096)))),
  search_id: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(200)))),
});

const decodeInput = Schema.decodeUnknownEffect(FindServiceInput);
const encodeInput = Schema.encodeEffect(Schema.fromJsonString(FindServiceInput));
const decodeOutput = Schema.decodeUnknownEffect(FindServiceOutput);

/** Explicit tool invocation; never uploads history or executes returned setup instructions. */
export function makeDeepAIFindService(
  account: DeepAIToolApi,
): (input: unknown) => Effect.Effect<DeepAIToolResult, DeepAIAccountError> {
  return (input) =>
    Effect.gen(function* () {
      const request = yield* decodeInput(input);
      const encoded = yield* encodeInput(request);
      if (!request.query.trim() || encoded.length > 8_000) {
        return yield* new DeepAIAccountError({
          operation: "service search input",
          cause: "Invalid input",
        });
      }
      const raw = yield* account.api("/find_service", {
        ...request,
        query: request.query.trim(),
      });
      const response = yield* decodeOutput(raw);
      const sources: Array<{ title: string; url: string }> = [];
      if (response.click_url) {
        const url = yield* Effect.try({
          try: () => new URL(response.click_url as string),
          catch: () =>
            new DeepAIAccountError({
              operation: "service search response",
              cause: "Invalid URL",
            }),
        });
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
          return yield* new DeepAIAccountError({
            operation: "service search response",
            cause: "Invalid URL",
          });
        }
        sources.push({ title: response.name || "Sign up", url: response.click_url });
      }
      return {
        content: [{ type: "text" as const, text: response.text || "No matching service found." }],
        details: {
          sources,
          ...(response.search_id ? { search_id: response.search_id } : {}),
        },
      };
    }).pipe(
      Effect.timeout("15 seconds"),
      Effect.orElseSucceed(() => ({
        content: [
          {
            type: "text" as const,
            text: "Service recommendations are unavailable. Continue without a recommendation or try again later.",
          },
        ],
        details: { sources: [] as Array<{ title: string; url: string }> },
      })),
    );
}
