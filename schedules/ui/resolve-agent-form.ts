import type { AgentProviderDefinition } from "@omp-desktop/protocol/provider-manifest";
import type {
  AgentModelDefinition,
  AgentProvider,
  ProviderSnapshotEntry,
} from "@omp-desktop/protocol/agent-types";
import {
  type FormPreferences,
} from "./preferences";
import { findModelByReference } from "./model-catalog";

export interface FormInitialValues {
  serverId?: string | null;
  provider?: AgentProvider;
  modeId?: string | null;
  model?: string | null;
  thinkingOptionId?: string | null;
  workingDir?: string;
}

export interface FormState {
  serverId: string | null;
  provider: AgentProvider | null;
  modeId: string;
  model: string;
  thinkingOptionId: string;
  workingDir: string;
}

export interface UserModifiedFields {
  serverId: boolean;
  provider: boolean;
  modeId: boolean;
  model: boolean;
  thinkingOptionId: boolean;
  workingDir: boolean;
}

export type ProviderModelsByProvider = Map<AgentProvider, AgentModelDefinition[] | null>;

export const INITIAL_USER_MODIFIED: UserModifiedFields = {
  serverId: false,
  provider: false,
  modeId: false,
  model: false,
  thinkingOptionId: false,
  workingDir: false,
};

type ProviderPrefs = NonNullable<FormPreferences["providerPreferences"]>[AgentProvider];

export const RESOLVABLE_PROVIDER_STATUSES = new Set<ProviderSnapshotEntry["status"]>([
  "ready",
  "loading",
]);
export function normalizeSelectedModelId(modelId: string | null | undefined): string {
  return typeof modelId === "string" ? modelId.trim() : "";
}

export function resolveDefaultModel(
  availableModels: AgentModelDefinition[] | null,
): AgentModelDefinition | null {
  if (!availableModels || availableModels.length === 0) return null;
  return availableModels.find((model) => model.isDefault) ?? availableModels[0] ?? null;
}

export function resolveDefaultModelId(availableModels: AgentModelDefinition[] | null): string {
  return resolveDefaultModel(availableModels)?.id ?? "";
}

function resolveCanonicalModelId(
  availableModels: AgentModelDefinition[] | null,
  modelId: string,
): string {
  const normalizedModelId = normalizeSelectedModelId(modelId);
  if (!normalizedModelId || !availableModels) return normalizedModelId;
  return findModelByReference(availableModels, normalizedModelId)?.id ?? "";
}

export function resolveEffectiveModel(
  availableModels: AgentModelDefinition[] | null,
  modelId: string,
): AgentModelDefinition | null {
  if (!availableModels || availableModels.length === 0) return null;
  if (!normalizeSelectedModelId(modelId)) return null;
  return findModelByReference(availableModels, modelId) ?? resolveDefaultModel(availableModels);
}

function resolvePreferredThinkingOptionId(input: {
  availableModels: AgentModelDefinition[] | null;
  providerPrefs: ProviderPrefs | undefined;
  modelId: string;
}): string {
  const model = findModelByReference(input.availableModels, input.modelId);
  const modelReferences = model ? [model.id, ...(model.aliases ?? [])] : [input.modelId];
  for (const modelReference of modelReferences) {
    const thinkingOptionId = input.providerPrefs?.thinkingByModel?.[modelReference]?.trim();
    if (thinkingOptionId) return thinkingOptionId;
  }
  return "";
}

export function resolveThinkingOptionId(args: {
  availableModels: AgentModelDefinition[] | null;
  modelId: string;
  requestedThinkingOptionId: string;
}): string {
  const effectiveModel = resolveEffectiveModel(args.availableModels, args.modelId);
  const thinkingOptions = effectiveModel?.thinkingOptions ?? [];
  if (thinkingOptions.length === 0) return "";

  const normalizedThinkingOptionId = args.requestedThinkingOptionId.trim();
  if (
    normalizedThinkingOptionId &&
    thinkingOptions.some((option) => option.id === normalizedThinkingOptionId)
  ) {
    return normalizedThinkingOptionId;
  }

  return effectiveModel?.defaultThinkingOptionId ?? thinkingOptions[0]?.id ?? "";
}

const normalizeSelectedModeId = normalizeSelectedModelId;

function resolvePreferredModeId(input: {
  initialModeId?: string | null;
  preferredModeId?: string | null;
  providerDef: AgentProviderDefinition | undefined;
}): string {
  // Saved modes are user intent. Provider create config validates unknown modes
  // at submission time, so background form resolution should not erase them.
  const initialModeId = normalizeSelectedModeId(input.initialModeId);
  if (initialModeId) return initialModeId;

  const preferredModeId = normalizeSelectedModeId(input.preferredModeId);
  if (preferredModeId) return preferredModeId;

  const defaultModeId = input.providerDef?.defaultModeId;
  const modes = input.providerDef?.modes ?? [];
  if (defaultModeId && (modes.length === 0 || modes.some((mode) => mode.id === defaultModeId))) {
    return defaultModeId;
  }
  return modes[0]?.id ?? "";
}

export function buildProviderDefinitionMap(
  providerDefinitions: AgentProviderDefinition[],
): Map<AgentProvider, AgentProviderDefinition> {
  return new Map<AgentProvider, AgentProviderDefinition>(
    providerDefinitions.map((definition) => [definition.id, definition]),
  );
}

export function buildProviderDefinitionMapForStatuses(args: {
  snapshotEntries: ProviderSnapshotEntry[] | undefined;
  providerDefinitions: AgentProviderDefinition[];
  statuses: ReadonlySet<ProviderSnapshotEntry["status"]>;
}): Map<AgentProvider, AgentProviderDefinition> {
  if (!args.snapshotEntries?.length) {
    return buildProviderDefinitionMap(args.providerDefinitions);
  }

  const matchingProviders = new Set(
    args.snapshotEntries
      .filter(
        (entry) =>
          args.statuses.has(entry.status) &&
          entry.enabled &&
          // Import-only providers (pi/codex) expose no creation modes; they
          // are not valid targets for brand-new agent creation.
          (entry.provider === "omp" || (entry.modes?.length ?? 0) > 0),
      )
      .map((entry) => entry.provider),
  );

  return buildProviderDefinitionMap(
    args.providerDefinitions.filter((definition) => matchingProviders.has(definition.id)),
  );
}

function resolveProvider(input: {
  currentProvider: AgentProvider | null;
  userModified: boolean;
  initialValues: FormInitialValues | undefined;
  preferences: FormPreferences | null;
  allowedProviderMap: Map<AgentProvider, AgentProviderDefinition>;
}): AgentProvider | null {
  const { currentProvider, userModified, initialValues, preferences, allowedProviderMap } = input;
  if (userModified) {
    if (
      currentProvider &&
      allowedProviderMap.size > 0 &&
      !allowedProviderMap.has(currentProvider)
    ) {
      return null;
    }
    return currentProvider;
  }
  if (initialValues?.provider && allowedProviderMap.has(initialValues.provider)) {
    return initialValues.provider;
  }
  if (preferences?.provider && allowedProviderMap.has(preferences.provider)) {
    return preferences.provider;
  }
  if (currentProvider && allowedProviderMap.size > 0 && !allowedProviderMap.has(currentProvider)) {
    return null;
  }
  return currentProvider;
}

function resolveModeId(input: {
  provider: AgentProvider | null;
  userModified: boolean;
  currentModeId: string;
  initialValues: FormInitialValues | undefined;
  providerDef: AgentProviderDefinition | undefined;
  providerPrefs: ProviderPrefs | undefined;
}): string {
  const { provider, userModified, currentModeId, initialValues, providerDef, providerPrefs } =
    input;
  if (userModified) return currentModeId;
  if (!provider) return "";
  return resolvePreferredModeId({
    initialModeId: initialValues?.modeId,
    preferredModeId: providerPrefs?.mode,
    providerDef,
  });
}

function resolveModelField(input: {
  provider: AgentProvider | null;
  userModified: boolean;
  currentModel: string;
  initialValues: FormInitialValues | undefined;
  providerPrefs: ProviderPrefs | undefined;
  availableModels: AgentModelDefinition[] | null;
}): string {
  const { provider, userModified, currentModel, initialValues, providerPrefs, availableModels } =
    input;
  if (userModified) return currentModel;
  if (!provider) return "";
  const initialModel = normalizeSelectedModelId(initialValues?.model);
  const preferredModel = normalizeSelectedModelId(providerPrefs?.model);
  const defaultModelId = resolveDefaultModelId(availableModels);
  if (initialModel) {
    return !availableModels
      ? initialModel
      : resolveCanonicalModelId(availableModels, initialModel) || defaultModelId;
  }
  if (preferredModel) {
    return !availableModels
      ? preferredModel
      : resolveCanonicalModelId(availableModels, preferredModel) || defaultModelId;
  }
  return "";
}

function resolveThinkingOption(input: {
  provider: AgentProvider | null;
  userModified: boolean;
  currentThinkingOptionId: string;
  modelId: string;
  initialValues: FormInitialValues | undefined;
  providerPrefs: ProviderPrefs | undefined;
  availableModels: AgentModelDefinition[] | null;
}): string {
  const {
    provider,
    userModified,
    currentThinkingOptionId,
    modelId,
    initialValues,
    providerPrefs,
    availableModels,
  } = input;
  if (!provider) return "";
  if (userModified) return currentThinkingOptionId;
  const initialThinkingOptionId =
    typeof initialValues?.thinkingOptionId === "string"
      ? initialValues.thinkingOptionId.trim()
      : "";
  const preferredThinking = resolvePreferredThinkingOptionId({
    availableModels,
    providerPrefs,
    modelId,
  });
  if (initialThinkingOptionId.length > 0) return initialThinkingOptionId;
  if (preferredThinking.length > 0) return preferredThinking;
  return "";
}

export function resolveFormState(
  initialValues: FormInitialValues | undefined,
  preferences: FormPreferences | null,
  availableModels: AgentModelDefinition[] | null,
  userModified: UserModifiedFields,
  currentState: FormState,
  allowedProviderMap: Map<AgentProvider, AgentProviderDefinition>,
): FormState {
  const result = { ...currentState };

  result.provider = resolveProvider({
    currentProvider: result.provider,
    userModified: userModified.provider,
    initialValues,
    preferences,
    allowedProviderMap,
  });

  const providerDef = result.provider ? allowedProviderMap.get(result.provider) : undefined;
  const providerPrefs = result.provider
    ? preferences?.providerPreferences?.[result.provider]
    : undefined;

  result.modeId = resolveModeId({
    provider: result.provider,
    userModified: userModified.modeId,
    currentModeId: result.modeId,
    initialValues,
    providerDef,
    providerPrefs,
  });

  result.model = resolveModelField({
    provider: result.provider,
    userModified: userModified.model,
    currentModel: result.model,
    initialValues,
    providerPrefs,
    availableModels,
  });

  result.thinkingOptionId = resolveThinkingOption({
    provider: result.provider,
    userModified: userModified.thinkingOptionId,
    currentThinkingOptionId: result.thinkingOptionId,
    modelId: result.model,
    initialValues,
    providerPrefs,
    availableModels,
  });

  if (result.provider && availableModels) {
    result.thinkingOptionId = resolveThinkingOptionId({
      availableModels,
      modelId: result.model,
      requestedThinkingOptionId: result.thinkingOptionId,
    });
  }

  if (!userModified.serverId && initialValues?.serverId !== undefined) {
    result.serverId = initialValues.serverId;
  }

  if (!userModified.workingDir && initialValues?.workingDir !== undefined) {
    result.workingDir = initialValues.workingDir;
  }

  return result;
}

export function resolveFormStateFromProviderModels(
  initialValues: FormInitialValues | undefined,
  preferences: FormPreferences | null,
  providerModelsByProvider: ProviderModelsByProvider,
  userModified: UserModifiedFields,
  currentState: FormState,
  allowedProviderMap: Map<AgentProvider, AgentProviderDefinition>,
): FormState {
  const providerResolved = resolveFormState(
    initialValues,
    preferences,
    null,
    userModified,
    currentState,
    allowedProviderMap,
  );
  const availableModels = providerResolved.provider
    ? (providerModelsByProvider.get(providerResolved.provider) ?? null)
    : null;

  return resolveFormState(
    initialValues,
    preferences,
    availableModels,
    userModified,
    currentState,
    allowedProviderMap,
  );
}
