import {
  ProviderDriverKind,
  ProviderSetupError,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";

import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import type { ManagedPiConnection } from "@t3tools/provider-core/server/ProviderHost";
import * as ProviderAuthFlow from "@t3tools/provider-core/server/providerAuthFlow";

import * as ServerConfig from "../config.ts";

import { deepAIAccountId, deepAIPiModels, DeepAISignInError } from "./api.ts";
import { DeepAIAccount } from "./DeepAIAccount.ts";
import { startDeepAISignIn } from "./localTransport.ts";
import { withDeepAIModelRates } from "./modelRates.ts";

const DRIVER = ProviderDriverKind.make("pi");
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeSettingsJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

/**
 * Builds the managed Pi connection for a DeepAI-flagged instance: Pi gets a
 * private agent dir (models.json pointing at the loopback transport, retry
 * settings), the hosted provider pinned on launch, the sign-in flow, and a
 * snapshot decorated with the account's auth status, models, and rates.
 */
export const makeDeepAIPiConnection = Effect.fn("makeDeepAIPiConnection")(function* (
  instanceId: ProviderInstanceId,
) {
  const account = yield* DeepAIAccount;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* SecureRandom.SecureRandom;

  const directory = path.join(config.stateDir, "deepai", "pi", instanceId);
  const modelsPath = path.join(directory, "models.json");
  const setupFailure = (
    operation: string,
    detail = "Could not complete DeepAI sign-in. Please try again.",
  ) => new ProviderSetupError({ instanceId, operation, detail });

  const writeModels = Effect.gen(function* () {
    const models = yield* account.models;
    const content = yield* encodeJson(
      deepAIPiModels(account.transport.baseUrl, account.transport.capability, models),
    );
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    yield* fs.chmod(directory, 0o700);
    const suffix = yield* crypto.uuidV4();
    const temporary = `${modelsPath}.${suffix}.tmp`;
    yield* Effect.acquireUseRelease(
      fs.writeFileString(temporary, content, { mode: 0o600 }).pipe(Effect.as(temporary)),
      (file) => fs.rename(file, modelsPath),
      (file) => fs.remove(file, { force: true }).pipe(Effect.orDie),
    );
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderDriverError({
          driver: DRIVER,
          instanceId,
          detail: "Could not prepare the DeepAI model connection.",
          cause,
        }),
    ),
  );

  const refresh = account.refreshModels.pipe(Effect.andThen(writeModels));
  yield* writeModels;

  yield* Effect.gen(function* () {
    const settingsPath = path.join(directory, "settings.json");
    const previousSettings = (yield* fs.exists(settingsPath))
      ? yield* fs.readFileString(settingsPath).pipe(
          Effect.flatMap(decodeSettingsJson),
          Effect.orElseSucceed(() => ({})),
        )
      : {};
    const settingsContent = yield* encodeJson({
      ...previousSettings,
      retry: { enabled: true, maxRetries: 5, baseDelayMs: 5_000 },
    });
    const temporary = `${settingsPath}.${yield* crypto.uuidV4()}.tmp`;
    yield* Effect.acquireUseRelease(
      fs.writeFileString(temporary, settingsContent, { mode: 0o600 }),
      () => fs.rename(temporary, settingsPath),
      () => fs.remove(temporary, { force: true }).pipe(Effect.orDie),
    );
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderDriverError({
          driver: DRIVER,
          instanceId,
          detail: "Could not prepare model recovery settings.",
          cause,
        }),
    ),
  );

  const run = Effect.runPromiseWith(yield* Effect.context<never>());
  const auth = yield* ProviderAuthFlow.make({
    instanceId,
    credentialBinding: { owner: "t3", key: "deepai-account" },
    methods: Effect.succeed([
      {
        id: "deepai",
        name: "Sign in to DeepAI",
        description: "Use your DeepAI account and hosted models.",
        type: "agent" as const,
      },
    ]),
    defaultMethodId: "deepai",
    authenticate: Effect.fn("DeepAIAuth.authenticate")(function* (methodId, flow) {
      if (methodId !== "deepai") return yield* setupFailure("sign-in");
      const controller = yield* Effect.acquireRelease(
        Effect.sync(() => new AbortController()),
        (controller) => Effect.sync(() => controller.abort()),
      );
      const listener = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            startDeepAISignIn({
              confirmationUrl: account.transport.newSignInConfirmationUrl(),
              signal: controller.signal,
              save: (credentials, signal) => run(account.saveCredentials(credentials), { signal }),
            }),
          catch: () =>
            setupFailure(
              "sign-in",
              "DeepAI Code could not open its local sign-in listener. Check that local connections are allowed, then start sign-in again.",
            ),
        }),
        (listener) => Effect.sync(() => listener.close()),
      );
      yield* flow.setInteraction(
        {
          type: "browser",
          id: flow.flowId,
          url: listener.url,
          requiresConsent: true,
        },
        () => Effect.void,
      );
      yield* Effect.tryPromise({
        try: () => listener.done,
        catch: (cause) =>
          cause instanceof DeepAISignInError
            ? new ProviderSetupError({
                instanceId,
                operation: "sign-in",
                detail: cause.message,
              })
            : setupFailure("sign-in"),
      });
      yield* flow.verifying;
      yield* refresh.pipe(
        Effect.mapError(() =>
          setupFailure(
            "model configuration",
            "You’re signed in, but DeepAI Code could not update its local model configuration. Check that the app can write to its data folder, then restart it.",
          ),
        ),
      );
    }),
    logout: account.logout.pipe(Effect.mapError(() => setupFailure("sign-out"))),
  });

  const respond = auth.respond ?? (() => Effect.fail(setupFailure("sign-in")));
  const decorateSnapshot = (snapshot: Parameters<ManagedPiConnection["decorateSnapshot"]>[0]) =>
    Effect.map(
      Effect.all({ credentials: account.credentials, catalog: account.models }),
      ({ credentials, catalog }) => ({
        ...snapshot,
        displayName: "DeepAI",
        configurableProviders: false,
        models: snapshot.models
          .filter((model) => model.subProvider === "deepai" || model.slug.startsWith("deepai/"))
          .map((model) => withDeepAIModelRates(model, catalog)),
        setup: {
          ...snapshot.setup,
          canAuthenticate: true,
          canInstall: snapshot.setup?.canInstall ?? false,
        },
        auth: credentials
          ? {
              status: "authenticated" as const,
              type: "deepai",
              label: credentials.username || "DeepAI",
              profileId: deepAIAccountId(credentials.apiKey),
              canLogout: true,
            }
          : {
              status: "unauthenticated" as const,
              type: "deepai",
              label: "Sign in to DeepAI",
              canLogout: false,
            },
        ...(snapshot.installed && snapshot.enabled
          ? {
              status: credentials ? snapshot.status : ("warning" as const),
              message: credentials
                ? snapshot.status === "ready"
                  ? "Connected to DeepAI."
                  : snapshot.message
                : "Sign in to DeepAI to use hosted models.",
            }
          : {}),
      }),
    );

  const connection: ManagedPiConnection = {
    environment: {
      PI_CODING_AGENT_DIR: directory,
      T3_DEEPAI_URL: account.transport.baseUrl,
      T3_DEEPAI_TOKEN: account.transport.capability,
    },
    launchArgs: "--provider deepai --model glm-5.3-flash",
    auth: {
      ...auth,
      respond: (owner, input) => {
        const result = respond(owner, input);
        return input.response.type === "browser" && input.response.action === "decline"
          ? result.pipe(Effect.andThen(auth.cancel(owner, input.flowId)))
          : result;
      },
    },
    refresh,
    decorateSnapshot,
    changes: account.changes,
  };
  return connection;
});
