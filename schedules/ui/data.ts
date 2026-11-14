import type { OmpApi, OmpAgent, OmpWorkspace, OmpWorkspaceListResult } from "@omp-desktop/client";
import type { PluginClientContext } from "@omp-desktop/plugin";
import type { StoredSchedule } from "@omp-desktop/protocol/schedule/types";
import { listSchedules } from "../rpc";
import { buildScheduleProjectTargets, type ScheduleProjectTarget } from "./schedule-project-targets";
import type { ScheduleFormHost } from "./schedule-form-model";

export interface ScheduleHost { id: string; label: string; online: boolean }
export interface AggregatedSchedule extends StoredSchedule { serverId: string; serverName: string }
export interface ScheduleDirectory {
  schedules: AggregatedSchedule[];
  hosts: ScheduleFormHost[];
  projectTargets: ScheduleProjectTarget[];
  agents: Map<string, OmpAgent>;
  agentReadyHosts: Set<string>;
  errors: { hostId: string; label: string; message: string }[];
  connected: boolean;
}
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

async function fetchAgents(api: OmpApi): Promise<OmpAgent[]> {
  const agents: OmpAgent[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.agents.list({ filter: { includeArchived: true }, page: { limit: 200, ...(cursor ? { cursor } : {}) } });
    agents.push(...page.entries.map(entry => entry.agent));
    cursor = page.pageInfo.hasMore ? page.pageInfo.nextCursor ?? undefined : undefined;
  } while (cursor);
  return agents;
}
async function fetchProjects(api: OmpApi): Promise<{ workspaces: OmpWorkspace[]; emptyProjects: OmpWorkspaceListResult["emptyProjects"] }> {
  const workspaces: OmpWorkspace[] = [];
  const emptyProjects: OmpWorkspaceListResult["emptyProjects"] = [];
  let cursor: string | undefined;
  do {
    const page = await api.workspaces.list({ page: { limit: 200, ...(cursor ? { cursor } : {}) } });
    workspaces.push(...page.entries);
    emptyProjects.push(...page.emptyProjects);
    cursor = page.pageInfo.hasMore ? page.pageInfo.nextCursor ?? undefined : undefined;
  } while (cursor);
  return { workspaces, emptyProjects };
}
export async function fetchScheduleDirectory(ctx: PluginClientContext, hosts: readonly ScheduleHost[]): Promise<ScheduleDirectory> {
  const directory: ScheduleDirectory = { schedules: [], hosts: [], projectTargets: [], agents: new Map(), agentReadyHosts: new Set(), errors: [], connected: false };
  let attempts = 0;
  let answered = 0;
  await Promise.all(hosts.map(async host => {
    const scoped = host.online ? ctx.hosts.get(host.id) : null;
    if (!scoped) return;
    attempts++;
    directory.connected = true;
    const recordError = (error: unknown) => directory.errors.push({ hostId: host.id, label: host.label, message: errorMessage(error) });
    await Promise.all([
      scoped.rpc(listSchedules, {}).then(schedules => { answered++; directory.schedules.push(...schedules.map(schedule => ({ ...schedule, serverId: host.id, serverName: host.label }))); }, recordError),
      scoped.omp.host.info().then(info => { directory.hosts.push({ serverId: host.id, label: host.label, supportsWorkspaceMultiplicity: info.features?.workspaceMultiplicity === true }); }, recordError),
      fetchAgents(scoped.omp).then(agents => { directory.agentReadyHosts.add(host.id); for (const agent of agents) directory.agents.set(`${host.id}:${agent.id}`, agent); }, recordError),
      fetchProjects(scoped.omp).then(projects => { directory.projectTargets.push(...buildScheduleProjectTargets(host, projects.workspaces, projects.emptyProjects)); }, recordError),
    ]);
  }));
  if (attempts > 0 && answered === 0) throw new Error(directory.errors.map(error => `${error.label}: ${error.message}`).join("\n"));
  directory.hosts.sort((a, b) => a.label.localeCompare(b.label));
  directory.schedules.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return directory;
}
