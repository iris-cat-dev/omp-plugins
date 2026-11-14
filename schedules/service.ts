import type { PluginServiceContext } from "@omp-desktop/plugin/server";
import { ScheduleService, type ScheduleLogger } from "./engine.js";
import { importLegacySchedules } from "./importer.js";
import { registerScheduleTools } from "./tools.js";
import {
  createSchedule, createOrReplaceSchedule, listSchedules, inspectSchedule,
  scheduleLogs, pauseSchedule, resumeSchedule, runScheduleOnce,
  deleteSchedule, updateSchedule, completeSchedulesForAgent,
} from "./rpc.js";

const logger: ScheduleLogger = {
  warn: (details, message) => console.warn(`[schedules] ${message}`, details),
  error: (details, message) => console.error(`[schedules] ${message}`, details),
};

export default async function setup(ctx: PluginServiceContext) {
  let engine: ScheduleService | null = null;
  const stop = () => engine?.stop();
  ctx.own(stop);
  ctx.signal.addEventListener("abort", stop, { once: true });
  const dataDirectory = await ctx.native.invoke<string>("files.data-directory", {});
  await importLegacySchedules(dataDirectory, ctx.installation.id);
  if (ctx.signal.aborted) return stop;
  engine = new ScheduleService({
    dataDirectory, api: ctx.omp, native: ctx.native, logger,
    onChange: () => {
      if (!ctx.signal.aborted) {
        void ctx.native.invoke("events.changed", {}).catch((error) => {
          if (!ctx.signal.aborted) logger.warn({ err: error }, "Failed to publish schedule changes");
        });
      }
    },
  });
  const service = engine;
  ctx.handle(createSchedule, (input) => service.create(input));
  ctx.handle(createOrReplaceSchedule, (input) => service.createOrReplace(input));
  ctx.handle(listSchedules, () => service.list());
  ctx.handle(inspectSchedule, ({ id }) => service.inspect(id));
  ctx.handle(scheduleLogs, ({ id }) => service.logs(id));
  ctx.handle(pauseSchedule, ({ id }) => service.pause(id));
  ctx.handle(resumeSchedule, ({ id }) => service.resume(id));
  ctx.handle(runScheduleOnce, ({ id }) => service.runOnce(id));
  ctx.handle(deleteSchedule, async ({ id }) => { await service.delete(id); return { deleted: true as const }; });
  ctx.handle(updateSchedule, (input) => service.update(input));
  ctx.handle(completeSchedulesForAgent, async ({ agentId }) => ({ completed: await service.completeForAgent(agentId) }));
  registerScheduleTools(ctx, service);
  const unwatch = ctx.own(await ctx.omp.agents.watch((update) => {
    const agentId = update.kind === "remove" ? update.agentId : update.agent.archivedAt ? update.agent.id : null;
    if (agentId && !ctx.signal.aborted) {
      void service.completeForAgent(agentId).catch((error) => {
        if (!ctx.signal.aborted) logger.warn({ err: error, agentId }, "Failed to complete schedules for removed or archived agent");
      });
    }
  }));
  await service.start();
  return async () => {
    ctx.signal.removeEventListener("abort", stop);
    await service.stop();
    await unwatch();
  };
}
