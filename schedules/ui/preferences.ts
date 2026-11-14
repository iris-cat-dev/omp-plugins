import { z } from "zod";

export interface ProviderPreferences {
  model?: string;
  mode?: string;
  thinkingByModel?: Record<string, string>;
}
export interface FormPreferences {
  provider?: string;
  providerPreferences?: Record<string, ProviderPreferences>;
  isolation?: "local" | "worktree";
}
export const FormPreferencesSchema = z.object({
  provider: z.string().optional(),
  providerPreferences: z.record(z.string(), z.object({ model: z.string().optional(), mode: z.string().optional(), thinkingByModel: z.record(z.string(), z.string()).optional() })).optional(),
  isolation: z.enum(["local", "worktree"]).optional(),
});
export function selectionPreferences(preferences: FormPreferences, state: { selectedProvider: string | null; selectedModel: string; selectedMode: string; selectedThinkingOptionId: string; isolation: "local" | "worktree" }): FormPreferences {
  if (!state.selectedProvider) return preferences;
  const previous = preferences.providerPreferences?.[state.selectedProvider];
  return { ...preferences, provider: state.selectedProvider, isolation: state.isolation, providerPreferences: { ...preferences.providerPreferences, [state.selectedProvider]: { ...previous, model: state.selectedModel, mode: state.selectedMode, thinkingByModel: { ...previous?.thinkingByModel, [state.selectedModel]: state.selectedThinkingOptionId } } } };
}
