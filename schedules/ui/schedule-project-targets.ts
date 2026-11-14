import type { OmpWorkspace, OmpWorkspaceListResult } from "@omp-desktop/client";
import { shortenPath } from "./shorten-path";

export const PROJECT_OPTION_PREFIX = "project:";
export interface ScheduleProjectTarget {
  optionId: string;
  serverId: string;
  serverName: string;
  projectViewKey: string;
  projectName: string;
  cwd: string;
  isGit: boolean;
}
export function buildProjectOptionId(serverId: string, projectViewKey: string): string {
  return `${PROJECT_OPTION_PREFIX}${serverId}:${projectViewKey}`;
}
export function buildScheduleProjectTargets(host: { id: string; label: string }, workspaces: readonly OmpWorkspace[], emptyProjects: OmpWorkspaceListResult["emptyProjects"]): ScheduleProjectTarget[] {
  const targets = new Map<string, ScheduleProjectTarget>();
  for (const project of [...workspaces, ...emptyProjects]) {
    const cwd = project.projectRootPath.trim();
    if (!cwd) continue;
    targets.set(cwd, { optionId: buildProjectOptionId(host.id, project.projectId), serverId: host.id, serverName: host.label, projectViewKey: project.projectId, projectName: project.projectDisplayName, cwd, isGit: project.projectKind === "git" });
  }
  return [...targets.values()];
}
export function buildProjectNameByCwd(targets: readonly ScheduleProjectTarget[]): Map<string, string> {
  return new Map(targets.map(target => [`${target.serverId}:${target.cwd.trim()}`, target.projectName]));
}
export function describeScheduleCwd(input: { serverId: string; cwd: string; projectNameByCwd: ReadonlyMap<string, string> }): string {
  return input.projectNameByCwd.get(`${input.serverId}:${input.cwd.trim()}`) ?? shortenPath(input.cwd);
}
