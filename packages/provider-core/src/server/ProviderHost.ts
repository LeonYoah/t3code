import type {
  BackgroundScope,
  ChatAttachment,
  ProviderInstanceId,
  ServerProvider,
  ServerSettings,
  ServerSettingsError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

import type { ProviderAuthController } from "./auth.ts";
import type { ProviderCredentialError, ProviderDriverError } from "./errors.ts";

export interface ProviderHostPaths {
  readonly cwd: string;
  readonly baseDir: string;
  readonly stateDir: string;
  readonly providerStatusCacheDir: string;
  /** Where chat attachments are stored; agents that sandbox file reads must be granted it. */
  readonly attachmentsDir: string;
}

export interface ProviderCredentials {
  /** Instances whose bindings are equal share these credentials. */
  readonly binding: { readonly owner: "t3"; readonly key: string };
  readonly get: Effect.Effect<Option.Option<Uint8Array>, ProviderCredentialError>;
  readonly set: (credentials: Uint8Array) => Effect.Effect<void, ProviderCredentialError>;
  readonly remove: Effect.Effect<void, ProviderCredentialError>;
}

/**
 * A hosted-model connection a Pi driver instance delegates to when its config
 * opts in (`PiSettings.deepai`). The connection owns credential storage, the
 * loopback transport Pi's model config points at, and the account's model
 * catalog; the driver folds its outputs into the instance snapshot and env.
 */
export interface ManagedPiConnection {
  /** Environment the managed instance launches with (pi agent dir, transport URL). */
  readonly environment: Readonly<Record<string, string>>;
  /** `pi --mode rpc` arguments pinning the hosted provider and default model. */
  readonly launchArgs: string;
  /** Sign-in controller surfaced on the provider instance. */
  readonly auth: ProviderAuthController;
  /** Re-fetch the account model catalog and rewrite Pi's managed model config. */
  readonly refresh: Effect.Effect<void, ProviderDriverError>;
  /** Layers the account view (auth, hosted models, rates) onto a probed snapshot. */
  readonly decorateSnapshot: (snapshot: ServerProvider) => Effect.Effect<ServerProvider>;
  /** Emits when account state changes; the driver refreshes the snapshot per emission. */
  readonly changes: Stream.Stream<unknown>;
}

export class ProviderHost extends Context.Service<
  ProviderHost,
  {
    readonly paths: ProviderHostPaths;
    readonly settings: {
      readonly get: Effect.Effect<ServerSettings, ServerSettingsError>;
      /** Runs `use` on a settings snapshot that no settings write can change until it finishes. */
      readonly withSnapshot: <A, E, R>(
        use: (settings: ServerSettings) => Effect.Effect<A, E, R>,
      ) => Effect.Effect<A, E | ServerSettingsError, R>;
      readonly changes: Stream.Stream<ServerSettings>;
      /** Changes buffered from the moment the scoped subscription is acquired. */
      readonly subscribe: Effect.Effect<Stream.Stream<ServerSettings>, never, Scope.Scope>;
    };
    readonly shouldRunBackgroundWork: (scope: BackgroundScope) => Effect.Effect<boolean>;
    /** Completes once server startup finishes; first provider checks wait for it. */
    readonly awaitServerReady?: Effect.Effect<void>;
    /** Absolute attachment path, or null if the ID does not resolve inside attachmentsDir. */
    readonly resolveAttachmentPath: (attachment: ChatAttachment) => string | null;
    readonly resolveExtractedTextPath?: (path: string) => Effect.Effect<string | undefined>;
    readonly credentials: (
      namespace: string,
      bindingId: string,
    ) => Effect.Effect<ProviderCredentials>;
    /**
     * Builds a managed hosted-model connection for a Pi instance inside the
     * instance's scope. Absent on builds without the hosted backend; drivers
     * fail the instance when a managed config cannot be served.
     */
    readonly managedPiConnection?: (
      instanceId: ProviderInstanceId,
    ) => Effect.Effect<ManagedPiConnection, ProviderDriverError, Scope.Scope>;
  }
>()("@t3tools/provider-core/server/ProviderHost") {}
