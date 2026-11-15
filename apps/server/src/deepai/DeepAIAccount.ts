import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";

import {
  BUNDLED_DEEPAI_MODELS,
  DEEPAI_BEACON_HEADER,
  DEEPAI_CHECK_IN_HEADER,
  DEEPAI_LANE_VERSION,
  DeepAIHttpStatusError,
  decodeDeepAIModels,
  deepAIAccountId,
  deepAIBeacon,
  readDeepAICheckIn,
  requestDeepAIJson,
  type DeepAICredentials,
  type DeepAIModel,
} from "./api.ts";
import { makeDeepAIFindService } from "./DeepAIFindService.ts";
import { makeDeepAIWebSearch } from "./DeepAIWebSearch.ts";
import { DeepAIAccountError } from "./errors.ts";
import { startDeepAIModelTransport, type DeepAIModelTransport } from "./localTransport.ts";
import { isDeepAIModelMetered } from "./modelRates.ts";

const CREDENTIAL_NAME = "deepai-account";

const Credentials = Schema.Struct({
  apiKey: Schema.NonEmptyString,
  username: Schema.String,
  isPro: Schema.Boolean,
});
const decodeCredentials = Schema.decodeUnknownOption(Schema.fromJsonString(Credentials));
const encodeCredentials = Schema.encodeEffect(Schema.fromJsonString(Credentials));

interface OwnershipEntry {
  readonly accountId: string | null;
  readonly since: number;
}

/**
 * Owns the DeepAI account: credentials in the server secret store, the live
 * model catalog, and the loopback transport Pi's managed model config points
 * at. Credentials never leave this service: the transport attaches `Api-Key`
 * to each relayed turn, and aborts in-flight work when the account changes.
 */
export class DeepAIAccount extends Context.Service<
  DeepAIAccount,
  {
    readonly credentials: Effect.Effect<DeepAICredentials | null>;
    readonly saveCredentials: (value: DeepAICredentials) => Effect.Effect<void, DeepAIAccountError>;
    readonly logout: Effect.Effect<void, DeepAIAccountError>;
    readonly accountId: Effect.Effect<string | null>;
    readonly models: Effect.Effect<ReadonlyArray<DeepAIModel>>;
    readonly refreshModels: Effect.Effect<ReadonlyArray<DeepAIModel>>;
    /** Emits when account state the provider snapshot depends on changed. */
    readonly changes: Stream.Stream<number>;
    readonly transport: DeepAIModelTransport;
    readonly api: (path: string, body?: unknown) => Effect.Effect<unknown, DeepAIAccountError>;
    /**
     * An api call pinned to the account that owned the timeline at `revision`;
     * fails if the account changed since the caller captured its owner.
     */
    readonly apiForOwner: (
      accountId: string,
      revision: number,
      path: string,
      body?: unknown,
    ) => Effect.Effect<unknown, DeepAIAccountError>;
    readonly ownershipTimeline: Effect.Effect<ReadonlyArray<OwnershipEntry>>;
  }
>()("t3/deepai/DeepAIAccount") {
  static layer = Layer.effect(
    DeepAIAccount,
    Effect.gen(function* () {
      const secrets = yield* ServerSecretStore;
      const scope = yield* Scope.Scope;
      const clock = yield* Clock.Clock;

      const revision = yield* SubscriptionRef.make(0);
      let current: DeepAICredentials | null = null;
      let catalog: ReadonlyArray<DeepAIModel> = BUNDLED_DEEPAI_MODELS;
      let catalogAccountId: string | null = null;
      let checkIn: { readonly nonce: string; readonly seconds: number } | null = null;
      const checkInLock = yield* Semaphore.make(1);
      let lastRelayAt: number | null = null;
      let lastCheckInAt = -Infinity;
      let lastLegacyCheckInAt = -Infinity;
      let retryCheckInAt = -Infinity;

      const notify = SubscriptionRef.update(revision, (n) => n + 1);
      const accountId = Effect.sync(() => (current ? deepAIAccountId(current.apiKey) : null));
      const credentials = Effect.sync(() => current);

      const restore = yield* secrets
        .get(CREDENTIAL_NAME)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isSome(restore)) {
        current = Option.getOrNull(decodeCredentials(new TextDecoder().decode(restore.value)));
      }
      const ownershipTimeline: OwnershipEntry[] = [
        { accountId: yield* accountId, since: yield* Clock.currentTimeMillis },
      ];

      const run = Effect.runPromiseWith(yield* Effect.context<never>());

      const noteCheckIn = (payload: unknown) => {
        const next = readDeepAICheckIn(payload);
        if (next) {
          checkIn = next;
          lastCheckInAt = clock.currentTimeMillisUnsafe();
        } else if (
          typeof payload === "object" &&
          payload !== null &&
          "enabled" in payload &&
          typeof payload.enabled === "boolean" &&
          (payload.enabled === false ||
            !("lane_version" in payload) ||
            (typeof payload.lane_version === "number" &&
              payload.lane_version < DEEPAI_LANE_VERSION))
        ) {
          lastLegacyCheckInAt = clock.currentTimeMillisUnsafe();
        }
      };
      const checkInHeaders = () => {
        const piActive =
          lastRelayAt !== null &&
          clock.currentTimeMillisUnsafe() - lastRelayAt < (checkIn?.seconds ?? 600) * 1e3;
        return {
          ...(checkIn ? { [DEEPAI_CHECK_IN_HEADER]: checkIn.nonce } : {}),
          [DEEPAI_BEACON_HEADER]: deepAIBeacon({ focused: null, piActive }),
        };
      };

      // @effect-diagnostics-next-line abortControllerInEffect:off - aborts raw transport fetches when the account changes; the work it cancels lives in promises, not fibers.
      let requests = new AbortController();
      const accountRequest = (
        path: string,
        body: unknown,
        ownership?: { accountId: string | null; revision: number },
      ) =>
        Effect.tryPromise({
          try: async (signal) => {
            const account = current;
            if (!account) throw new Error("Sign in required.");
            if (
              ownership &&
              (deepAIAccountId(account.apiKey) !== ownership.accountId ||
                ownershipTimeline.length !== ownership.revision)
            ) {
              throw new Error("DeepAI account changed.");
            }
            let result: unknown;
            try {
              result = await requestDeepAIJson(
                path,
                account.apiKey,
                AbortSignal.any([signal, requests.signal, AbortSignal.timeout(30_000)]),
                body,
                path === "/theos" ? checkInHeaders() : undefined,
              );
            } catch (error) {
              if (
                current === account &&
                path === "/theos" &&
                error instanceof DeepAIHttpStatusError
              ) {
                retryCheckInAt = -Infinity;
                noteCheckIn(error.body);
              }
              throw error;
            }
            if (current !== account) throw new Error("DeepAI account changed.");
            if (path === "/theos") noteCheckIn(result);
            return result;
          },
          catch: (cause) => new DeepAIAccountError({ operation: "account request", cause }),
        });
      const api = (path: string, body?: unknown) => accountRequest(path, body);

      const refreshModels = Effect.tryPromise({
        try: async (signal) => {
          const account = current;
          if (!account) return catalog;
          const models = decodeDeepAIModels(
            await requestDeepAIJson(
              "/models",
              account.apiKey,
              AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
            ),
          );
          if (current !== account) return catalog;
          catalog = models;
          catalogAccountId = deepAIAccountId(account.apiKey);
          return models;
        },
        catch: (cause) => new DeepAIAccountError({ operation: "model catalog", cause }),
      }).pipe(Effect.orElseSucceed(() => catalog));

      const ensureCheckedIn = checkInLock.withPermits(1)(
        Effect.gen(function* () {
          if (current === null) return;
          const markAge = () => clock.currentTimeMillisUnsafe() - lastCheckInAt;
          const legacyServer = () => clock.currentTimeMillisUnsafe() - lastLegacyCheckInAt < 30_000;
          if ((checkIn && markAge() < (checkIn.seconds * 1e3) / 2) || legacyServer()) {
            return;
          }
          if (
            checkIn &&
            markAge() < checkIn.seconds * 1e3 &&
            clock.currentTimeMillisUnsafe() < retryCheckInAt
          ) {
            return;
          }
          const result = yield* api("/theos").pipe(Effect.result);
          const validMark = checkIn !== null && markAge() < checkIn.seconds * 1e3;
          if (result._tag === "Failure") {
            const cause = result.failure.cause;
            if (
              validMark &&
              (!(cause instanceof DeepAIHttpStatusError) ||
                cause.status >= 500 ||
                readDeepAICheckIn(cause.body) !== null)
            ) {
              if (!(cause instanceof DeepAIHttpStatusError) || cause.status >= 500) {
                retryCheckInAt = clock.currentTimeMillisUnsafe() + 5_000;
              }
              return;
            }
            return yield* result.failure;
          }
          if (validMark || legacyServer()) return;
          return yield* new DeepAIAccountError({
            operation: "connection check-in",
            cause: "The server did not return a check-in.",
          });
        }),
      );

      const transport = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            startDeepAIModelTransport({
              readCredentials: () => run(credentials),
              metered: (model) => isDeepAIModelMetered(catalog, model),
              webSearch: (input, signal) => run(makeDeepAIWebSearch({ api })(input), { signal }),
              findService: (input, signal) =>
                run(makeDeepAIFindService({ api })(input), { signal }),
              ensureCheckedIn: async (signal) => {
                const result = await run(ensureCheckedIn.pipe(Effect.result), { signal });
                if (result._tag === "Failure") {
                  throw result.failure.cause instanceof DeepAIHttpStatusError
                    ? result.failure.cause
                    : result.failure;
                }
                lastRelayAt = clock.currentTimeMillisUnsafe();
              },
            }),
          catch: (cause) => new DeepAIAccountError({ operation: "local model transport", cause }),
        }),
        (transport) => Effect.sync(() => transport.close()),
      );

      const clearRequests = () => {
        requests.abort();
        requests = new AbortController();
        transport.cancelRequests();
        checkIn = null;
        lastRelayAt = null;
        lastCheckInAt = -Infinity;
        lastLegacyCheckInAt = -Infinity;
        retryCheckInAt = -Infinity;
      };

      const saveCredentials = Effect.fn("DeepAIAccount.saveCredentials")(function* (
        value: DeepAICredentials,
      ) {
        const encoded = yield* encodeCredentials(value).pipe(
          Effect.mapError(
            (cause) => new DeepAIAccountError({ operation: "credential storage", cause }),
          ),
        );
        yield* secrets
          .set(CREDENTIAL_NAME, new TextEncoder().encode(encoded))
          .pipe(
            Effect.mapError(
              (cause) => new DeepAIAccountError({ operation: "credential storage", cause }),
            ),
          );
        clearRequests();
        const since = yield* Clock.currentTimeMillis;
        current = value;
        ownershipTimeline.push({ accountId: deepAIAccountId(value.apiKey), since });
        if (catalogAccountId !== null && catalogAccountId !== deepAIAccountId(value.apiKey)) {
          catalog = BUNDLED_DEEPAI_MODELS;
          catalogAccountId = null;
        }
        yield* refreshModels;
        yield* notify;
      });

      const logout = Effect.gen(function* () {
        yield* secrets
          .remove(CREDENTIAL_NAME)
          .pipe(
            Effect.mapError((cause) => new DeepAIAccountError({ operation: "sign-out", cause })),
          );
        clearRequests();
        const since = yield* Clock.currentTimeMillis;
        current = null;
        ownershipTimeline.push({ accountId: null, since });
        yield* notify;
      });

      yield* refreshModels.pipe(Effect.andThen(notify), Effect.forkIn(scope));

      return DeepAIAccount.of({
        credentials,
        saveCredentials,
        logout,
        accountId,
        models: Effect.sync(() => catalog),
        refreshModels,
        changes: SubscriptionRef.changes(revision),
        transport,
        api,
        apiForOwner: Effect.fn("DeepAIAccount.apiForOwner")(
          function* (
            ownerId,
            ownerRevision,
            path,
            body,
          ): Effect.fn.Return<unknown, DeepAIAccountError> {
            const request = accountRequest(path, body, {
              accountId: ownerId,
              revision: ownerRevision,
            });
            return yield* path === "/chat/completions"
              ? ensureCheckedIn.pipe(Effect.andThen(request))
              : request;
          },
        ),
        ownershipTimeline: Effect.sync(() => ownershipTimeline.slice()),
      });
    }),
  );
}
