import type { ServerProviderModel } from "@t3tools/contracts";

import { isTheosAmount, type DeepAIModel } from "./api.ts";

/** undefined means the account catalog has not supplied a price. */
function hasMeteredRate(model: DeepAIModel | undefined): boolean | undefined {
  if (model?.theosPerRequest !== undefined) {
    return isTheosAmount(model.theosPerRequest) ? /[1-9]/.test(model.theosPerRequest) : undefined;
  }
  const rates = Object.values(model?.theosPerSecond ?? {});
  if (!rates.length || !rates.every(isTheosAmount)) return undefined;
  return rates.some((rate) => /[1-9]/.test(rate));
}

/** Whether a model spends Theos. Lane entries carry a per-request price ("0" when free) or,
 * from an older server, per-level rates; bundled entries only know `premier`; a model
 * missing from the catalog counts as metered. */
export function isDeepAIModelMetered(catalog: ReadonlyArray<DeepAIModel>, model: string): boolean {
  const entry = catalog.find((entry) => entry.id === model);
  if (!entry) return true;
  return hasMeteredRate(entry) ?? entry.premier === true;
}

/** Attach account-owned catalog pricing after Pi discovery, which drops extra model fields. */
export function withDeepAIModelRates(
  model: ServerProviderModel,
  catalog: ReadonlyArray<DeepAIModel>,
): ServerProviderModel {
  const entry = catalog.find((entry) => model.slug === `deepai/${entry.id}`);
  if (!entry) return model;
  return {
    ...model,
    contextWindow: entry.contextWindow,
    ...(entry.theosPerRequest === undefined ? {} : { theosPerRequest: entry.theosPerRequest }),
    ...(entry.theosPerSecond ? { theosPerSecond: { ...entry.theosPerSecond } } : {}),
  };
}
