import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import type { OmpApi, OmpAgent, OmpAgentConfig, OmpAgentRunOptions, OmpAgentRunResult } from "@omp-desktop/client";
import type { PluginAgentToolContribution, PluginServiceContext } from "@omp-desktop/plugin/server";

export function createApiHarness(cwd: string) {
  const agents = new Map<string, OmpAgent>();
  const configurations = new Map<string, OmpAgentConfig & { cwd: string; model?: string }>();
  const toolDefinitions = new Map<string, PluginAgentToolContribution>();
  const workspaces: Array<{ id: string; cwd: string; archived: boolean }> = [];
  const logger = { warn: vi.fn(), error: vi.fn() };
  const run = vi.fn(async (_prompt: string, _options?: OmpAgentRunOptions): Promise<OmpAgentRunResult> => ({ status: "idle", final: null, error: null, lastMessage: "done" }));
  const archive = vi.fn(async (id: string) => {
    const workspace = workspaces.find((entry) => entry.id === id);
    if (workspace) workspace.archived = true;
    return { requestId: "archive", workspaceId: id, archivedAt: new Date().toISOString(), error: null };
  });
  const createAgent = vi.fn(async (options: { config: OmpAgentConfig; title?: string | null; labels?: Record<string, string> }, workspaceId: string, directory: string) => {
    const id = randomUUID();
    const snapshot = { id, provider: options.config.provider.split("/", 1)[0], cwd: directory, workspaceId, archivedAt: null, currentModeId: options.config.modeId ?? null, title: options.title ?? null, labels: options.labels ?? {}, status: "idle" } as OmpAgent;
    agents.set(id, snapshot);
    configurations.set(id, { ...options.config, cwd: directory });
    return ref(id);
  });
  const ref = (id: string) => ({
    id, current: () => agents.get(id) ?? null,
    refresh: vi.fn(async () => agents.has(id) ? { agent: agents.get(id), project: null } : null),
    configuration: vi.fn(async () => {
      const config = configurations.get(id);
      if (!config) throw new Error(`Agent ${id} configuration not found`);
      return config;
    }),
    run,
  });
  const createWorkspace = vi.fn(async (options: { source: { kind: string; path?: string; cwd?: string }; firstAgentContext?: { prompt: string } }) => {
    const id = `wks_${workspaces.length + 1}`;
    const directory = options.source.path ?? options.source.cwd ?? cwd;
    workspaces.push({ id, cwd: directory, archived: false });
    return { id, directory, agents: { create: (options: Parameters<typeof createAgent>[0]) => createAgent(options, id, directory) } };
  });
  const resolveCreateConfig = vi.fn(async (config: Record<string, unknown>) => config);
  const agentListeners = new Set<(event: unknown) => void>();
  const api = {
    agents: {
      ref,
      watch: async (listener: (event: unknown) => void) => { agentListeners.add(listener); return () => { agentListeners.delete(listener); }; },
      subscribe: (listener: (event: unknown) => void) => { agentListeners.add(listener); return () => { agentListeners.delete(listener); }; },
    },
    workspaces: { create: createWorkspace, archive },
    providers: { resolveCreateConfig },
  } as unknown as OmpApi;
  const native = { invoke: vi.fn(async (operation: string, input?: { path?: string }) => operation === "files.resolve-path" ? input?.path ?? cwd : undefined) };
  const context = {
    omp: api, native,
    addAgentTool: (definition: PluginAgentToolContribution) => { toolDefinitions.set(definition.name, definition); return () => toolDefinitions.delete(definition.name); },
  } as unknown as PluginServiceContext;
  return { api, agents, configurations, run, archive, createAgent, createWorkspace, workspaces, resolveCreateConfig, context, toolDefinitions, native, logger, agentListeners };
}
