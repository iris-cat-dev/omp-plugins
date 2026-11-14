import { describe, expect, it, vi } from "vitest";
import type { PluginClientContext } from "@omp-desktop/plugin";
import type { StoredSchedule } from "@omp-desktop/protocol/schedule/types";
import { fetchScheduleDirectory } from "./data";

const schedule: StoredSchedule = { id: "schedule", name: "Nightly", prompt: "Run", cadence: { type: "every", everyMs: 90 * 60_000 }, target: { type: "new-agent", config: { provider: "omp", cwd: "/repo" } }, status: "active", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", nextRunAt: null, lastRunAt: null, pausedAt: null, expiresAt: null, maxRuns: null, runs: [] };
function connection(schedules: StoredSchedule[] = []) {
  return { rpc: vi.fn(async () => schedules), omp: { host: { info: async () => ({ features: { workspaceMultiplicity: true } }) }, agents: { list: vi.fn(async () => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null } })) }, workspaces: { list: vi.fn(async () => ({ entries: [], emptyProjects: [{ projectId: "empty", projectDisplayName: "Empty project", projectRootPath: "/repo", projectKind: "git" }], pageInfo: { hasMore: false, nextCursor: null } })) } } };
}
function context(connections: Record<string, ReturnType<typeof connection>>) {
  return { hosts: { get: (id: string) => connections[id] ?? null } } as unknown as PluginClientContext;
}
describe("plugin schedule directory", () => {
  it("returns an empty connected result without waiting for offline sibling hosts", async () => {
    const a = connection();
    const b = connection([schedule]);
    const result = await fetchScheduleDirectory(context({ a, b }), [{ id: "a", label: "A", online: true }, { id: "b", label: "B", online: false }]);
    expect(result.connected).toBe(true);
    expect(result.schedules).toEqual([]);
    expect(b.rpc).not.toHaveBeenCalled();
    expect(result.projectTargets[0]).toMatchObject({ serverId: "a", cwd: "/repo", projectName: "Empty project", isGit: true });
  });
  it("reports no connected host without requesting offline data", async () => {
    const result = await fetchScheduleDirectory(context({}), [{ id: "a", label: "A", online: false }]);
    expect(result.connected).toBe(false);
    expect(result.errors).toEqual([]);
  });
  it("tags schedules by host and keeps a successful host when a sibling fails", async () => {
    const a = connection([schedule]);
    const b = connection();
    b.rpc.mockRejectedValue(new Error("Unavailable"));
    const result = await fetchScheduleDirectory(context({ a, b }), [{ id: "a", label: "A", online: true }, { id: "b", label: "B", online: true }]);
    expect(result.schedules).toEqual([{ ...schedule, serverId: "a", serverName: "A" }]);
    expect(result.errors).toEqual([{ hostId: "b", label: "B", message: "Unavailable" }]);
  });
  it("rejects all-host failures so the UI can offer retry instead of a spinner", async () => {
    const a = connection(); a.rpc.mockRejectedValue(new Error("Unavailable"));
    await expect(fetchScheduleDirectory(context({ a }), [{ id: "a", label: "A", online: true }])).rejects.toThrow("A: Unavailable");
  });
  it("does not mark agent targets gone when their host directory fails", async () => {
    const a = connection([schedule]); a.omp.agents.list.mockRejectedValue(new Error("Directory unavailable"));
    const result = await fetchScheduleDirectory(context({ a }), [{ id: "a", label: "A", online: true }]);
    expect(result.agentReadyHosts.has("a")).toBe(false);
    expect(result.schedules).toHaveLength(1);
  });
});
