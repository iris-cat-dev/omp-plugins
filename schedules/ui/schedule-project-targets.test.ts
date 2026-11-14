import { describe, expect, it } from "vitest";
import type { OmpWorkspace, OmpWorkspaceListResult } from "@omp-desktop/client";
import { buildProjectNameByCwd, buildScheduleProjectTargets, describeScheduleCwd } from "./schedule-project-targets";

describe("schedule project targets", () => {
  it("deduplicates project roots across workspaces and includes empty project parents", () => {
    const projects = [{ projectId: "repo", projectDisplayName: "Repository", projectRootPath: "/repo", projectKind: "git" }, { projectId: "repo", projectDisplayName: "Repository", projectRootPath: "/repo", projectKind: "git" }] as OmpWorkspace[];
    const emptyProjects: OmpWorkspaceListResult["emptyProjects"] = [{ projectId: "plain", projectDisplayName: "Plain folder", projectRootPath: "/plain", projectKind: "non_git" }];
    const targets = buildScheduleProjectTargets({ id: "host-a", label: "A" }, projects, emptyProjects);
    expect(targets).toHaveLength(2);
    expect(targets[0]).toMatchObject({ optionId: "project:host-a:repo", cwd: "/repo", isGit: true });
    expect(targets[1]).toMatchObject({ cwd: "/plain", isGit: false });
    const names = buildProjectNameByCwd(targets);
    expect(describeScheduleCwd({ serverId: "host-a", cwd: "/repo", projectNameByCwd: names })).toBe("Repository");
    expect(describeScheduleCwd({ serverId: "host-b", cwd: "/repo", projectNameByCwd: names })).toBe("/repo");
  });
  it("uses the stored shortened path when no matching project exists", () => {
    expect(describeScheduleCwd({ serverId: "a", cwd: "/Users/alex/project", projectNameByCwd: new Map() })).toBe("~/project");
  });
});
