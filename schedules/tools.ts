import { z } from "zod";
import type { PluginServiceContext, PluginAgentToolContext } from "@omp-desktop/plugin/server";
import type { OmpApi } from "@omp-desktop/client";
import { everyMsToFiveFieldCron } from "@omp-desktop/protocol/schedule/cadence";
import type { ScheduleTarget, StoredSchedule, UpdateScheduleInput } from "@omp-desktop/protocol/schedule/types";
import { ScheduleService } from "./engine.js";

const nonblank = z.string().trim().min(1);
const idInput = z.object({ id: nonblank }).strict();
const cadenceInput = {
  prompt: nonblank, cron: nonblank,
  timezone: nonblank.optional().describe("IANA time zone, for example America/New_York."),
  name: z.string().optional(), maxRuns: z.number().int().positive().optional(), expiresIn: z.string().optional(),
};
export const createScheduleToolInput = z.object({
  ...cadenceInput,
  provider: nonblank.optional().describe("Provider or provider/model. Defaults to the authenticated caller's provider and model."),
  cwd: z.string().optional(), isolation: z.enum(["local", "worktree"]).optional(),
}).strict();
export const createHeartbeatToolInput = z.object(cadenceInput).strict();
export const updateScheduleToolInput = z.object({
  id: nonblank, cron: z.string().optional(), timezone: nonblank.optional(),
  name: z.string().nullable().optional(), prompt: nonblank.optional(),
  maxRuns: z.number().int().positive().nullable().optional(),
  provider: nonblank.optional(), model: nonblank.nullable().optional(), mode: nonblank.nullable().optional(),
  cwd: nonblank.optional(), expiresIn: z.string().optional(), clearExpires: z.boolean().optional(),
}).passthrough();

export function parseDurationString(input: string): number {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10) * 1000;
  let totalMs = 0;
  let hasMatch = false;
  const regex = /(\d+)([smh])/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(trimmed)) !== null) {
    hasMatch = true;
    const value = Number.parseInt(match[1], 10);
    switch (match[2]) {
      case "s": totalMs += value * 1000; break;
      case "m": totalMs += value * 60_000; break;
      case "h": totalMs += value * 3_600_000; break;
    }
  }
  if (!hasMatch) throw new Error(`Invalid duration format: ${input}. Use formats like: 5m, 30s, 1h, 2h30m`);
  return totalMs;
}

export function splitProviderModel(value: string): { provider: string; model?: string } {
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  if (slash === -1) {
    if (!trimmed) throw new Error("provider is required");
    return { provider: trimmed };
  }
  const provider = trimmed.slice(0, slash).trim();
  const model = trimmed.slice(slash + 1).trim();
  if (!provider || !model) throw new Error("provider must be <provider> or <provider>/<model>");
  return { provider, model };
}

function summary(schedule: StoredSchedule) {
  const { runs: _runs, ...value } = schedule;
  return value;
}
const response = (value: unknown) => ({ content: [], structuredContent: value });
const expiry = (value?: string) => value === undefined ? undefined : new Date(Date.now() + parseDurationString(value)).toISOString();

export function buildScheduleUpdateInput(input: z.output<typeof updateScheduleToolInput>): UpdateScheduleInput {
  const every = typeof input.every === "string" ? input.every.trim() || undefined : undefined;
  const cron = input.cron?.trim() || undefined;
  if (every && cron) throw new Error("Specify at most one of every or cron");
  if (input.timezone && !cron) throw new Error("timezone can only be used with cron");
  if (input.expiresIn !== undefined && input.clearExpires) throw new Error("Specify at most one of expiresIn or clearExpires");
  let cadence: UpdateScheduleInput["cadence"];
  if (every) {
    const expression = everyMsToFiveFieldCron(parseDurationString(every));
    if (!expression) throw new Error(`${every} cannot be represented faithfully by five-field cron`);
    cadence = { type: "cron", expression };
  } else if (cron) {
    cadence = { type: "cron", expression: cron, ...(input.timezone ? { timezone: input.timezone } : {}) };
  }
  const providerModel = input.provider ? splitProviderModel(input.provider) : undefined;
  if (providerModel?.model && input.model === null) throw new Error("provider specifies a model but model is null");
  if (providerModel?.model && input.model !== undefined && input.model !== providerModel.model) throw new Error("Conflicting model values provided");
  const newAgentConfig = {
    ...(providerModel?.provider ? { provider: providerModel.provider } : {}),
    ...(input.model !== undefined ? { model: input.model } : providerModel?.model ? { model: providerModel.model } : {}),
    ...(input.mode !== undefined ? { modeId: input.mode } : {}),
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
  };
  return {
    id: input.id,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
    ...(cadence ? { cadence } : {}),
    ...(input.maxRuns !== undefined ? { maxRuns: input.maxRuns } : {}),
    ...(input.expiresIn !== undefined ? { expiresAt: expiry(input.expiresIn) } : input.clearExpires ? { expiresAt: null } : {}),
    ...(Object.keys(newAgentConfig).length ? { newAgentConfig } : {}),
  };
}

export async function validateNewAgentConfig(api: OmpApi, config: Extract<ScheduleTarget, { type: "new-agent" }>["config"]): Promise<void> {
  await api.providers.resolveCreateConfig({
    provider: config.provider, cwd: config.cwd, model: config.model,
  });
}

export function registerScheduleTools(ctx: PluginServiceContext, service: ScheduleService): void {
  async function caller(context: PluginAgentToolContext) {
    if (!context.agentId) throw new Error("Heartbeat operations require an agent-scoped session");
    const handle = ctx.omp.agents.ref(context.agentId);
    const snapshot = (await handle.refresh())?.agent;
    if (!snapshot) throw new Error(`Parent agent ${context.agentId} not found`);
    return { snapshot, config: await handle.configuration() };
  }
  async function requireTarget(id: string, type: "agent" | "new-agent") {
    const schedule = await service.inspect(id);
    if (schedule.target.type !== type) throw new Error(type === "agent" ? `Heartbeat not found: ${id}` : `Schedule not found: ${id}`);
    return schedule;
  }
  const add = <I extends z.ZodType>(name: string, description: string, input: I, handler: (input: z.output<I>, context: PluginAgentToolContext) => Promise<unknown>) => {
    ctx.addAgentTool({ name, description, input, handler });
  };
  add("create_schedule", "Create a recurring schedule that starts a new agent on a cron cadence.", createScheduleToolInput, async (input, context) => {
    const agent = await caller(context);
    const inherited = splitProviderModel(agent.config.provider);
    const selected = input.provider !== undefined ? splitProviderModel(input.provider) : { ...inherited, model: agent.config.model ?? inherited.model };
    const sameProvider = selected.provider === agent.snapshot.provider;
    const cwd = input.cwd?.trim() ? await ctx.native.invoke<string>("files.resolve-path", { path: input.cwd }) : agent.snapshot.cwd;
    const config: Extract<ScheduleTarget, { type: "new-agent" }>["config"] = {
      provider: selected.provider, cwd,
      ...(selected.model ? { model: selected.model } : {}),
      ...(sameProvider && agent.snapshot.currentModeId ? { modeId: agent.snapshot.currentModeId } : {}),
      ...(agent.config.thinkingOptionId ? { thinkingOptionId: agent.config.thinkingOptionId } : {}),
      ...(sameProvider && agent.config.options ? { providerOptions: agent.config.options } : {}),
      ...(agent.config.featureValues ? { featureValues: agent.config.featureValues } : {}),
      ...(agent.config.systemPrompt ? { systemPrompt: agent.config.systemPrompt } : {}),
      ...(agent.config.mcpServers ? { mcpServers: agent.config.mcpServers } : {}),
      ...(input.isolation ? { isolation: input.isolation } : {}),
    };
    await validateNewAgentConfig(ctx.omp, config);
    const schedule = await service.createOrReplace({
      prompt: input.prompt, cadence: { type: "cron", expression: input.cron, ...(input.timezone ? { timezone: input.timezone } : {}) },
      target: { type: "new-agent", config }, name: input.name, maxRuns: input.maxRuns, expiresAt: expiry(input.expiresIn),
    });
    return response(summary(schedule));
  });
  add("create_heartbeat", "Create a recurring heartbeat that sends you a prompt on a cron cadence.", createHeartbeatToolInput, async (input, context) => {
    await caller(context);
    const schedule = await service.createOrReplace({
      prompt: input.prompt, cadence: { type: "cron", expression: input.cron, ...(input.timezone ? { timezone: input.timezone } : {}) },
      target: { type: "agent", agentId: context.agentId }, name: input.name, maxRuns: input.maxRuns, expiresAt: expiry(input.expiresIn),
    });
    return response(summary(schedule));
  });
  add("delete_heartbeat", "Delete one of your heartbeats.", idInput, async ({ id }, context) => {
    if (!context.agentId) throw new Error("Heartbeat operations require an agent-scoped session");
    const schedule = await requireTarget(id, "agent");
    if (schedule.target.type !== "agent" || schedule.target.agentId !== context.agentId) throw new Error(`Heartbeat ${id} does not belong to caller ${context.agentId}`);
    await service.delete(id);
    return response({ success: true });
  });
  add("list_schedules", "List all new-agent schedules managed by this installation.", z.object({}).strict(), async () => response({ schedules: (await service.list()).filter((item) => item.target.type === "new-agent").map(summary) }));
  add("inspect_schedule", "Inspect a schedule and its run history.", idInput, async ({ id }) => response(await requireTarget(id, "new-agent")));
  for (const operation of ["pause", "resume", "delete"] as const) {
    add(`${operation}_schedule`, `${operation} a new-agent schedule.`, idInput, async ({ id }) => {
      await requireTarget(id, "new-agent");
      await service[operation](id);
      return response({ success: true });
    });
  }
  add("update_schedule", "Update a new-agent schedule. Only provided fields are changed; omitted fields remain unchanged.", updateScheduleToolInput, async (input) => {
    const current = await requireTarget(input.id, "new-agent");
    const update = buildScheduleUpdateInput(input);
    if (update.newAgentConfig && current.target.type === "new-agent") {
      const config = { ...current.target.config };
      for (const [key, value] of Object.entries(update.newAgentConfig)) {
        if (value === null) delete (config as Record<string, unknown>)[key];
        else (config as Record<string, unknown>)[key] = value;
      }
      await validateNewAgentConfig(ctx.omp, config);
    }
    return response(await service.update(update));
  });
  add("schedule_logs", "Get the run history of a new-agent schedule.", idInput, async ({ id }) => {
    await requireTarget(id, "new-agent");
    return response({ runs: await service.logs(id) });
  });
  add("run_schedule_once", "Run a new-agent schedule immediately without changing its cadence.", idInput, async ({ id }) => {
    await requireTarget(id, "new-agent");
    return response(await service.runOnce(id));
  });
}
