import { defineRpc } from "@omp-desktop/plugin";
import { z } from "zod";
import {
  ScheduleCadenceSchema,
  ScheduleTargetSchema,
  ScheduleRunSchema,
  StoredScheduleSchema,
} from "@omp-desktop/protocol/schedule/types";

export const CreateScheduleInputSchema = z.object({
  name: z.string().nullable().optional(),
  prompt: z.string().trim().min(1),
  cadence: ScheduleCadenceSchema,
  target: ScheduleTargetSchema,
  maxRuns: z.number().int().positive().nullable().optional(),
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
  runOnCreate: z.boolean().nullable().optional(),
});
export const UpdateScheduleInputSchema = z.object({
  id: z.string().min(1),
  name: z.string().nullable().optional(),
  prompt: z.string().trim().min(1).optional(),
  cadence: ScheduleCadenceSchema.optional(),
  newAgentConfig: z.object({
    provider: z.string().trim().min(1).optional(),
    model: z.string().nullable().optional(),
    modeId: z.string().nullable().optional(),
    thinkingOptionId: z.string().nullable().optional(),
    archiveOnFinish: z.boolean().optional(),
    isolation: z.enum(["local", "worktree"]).optional(),
    cwd: z.string().trim().min(1).optional(),
  }).optional(),
  maxRuns: z.number().int().positive().nullable().optional(),
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
});
const idInput = z.object({ id: z.string().min(1) });
export const createSchedule = defineRpc({ name: "schedules.create", input: CreateScheduleInputSchema, output: StoredScheduleSchema });
export const createOrReplaceSchedule = defineRpc({ name: "schedules.create-or-replace", input: CreateScheduleInputSchema, output: StoredScheduleSchema });
export const listSchedules = defineRpc({ name: "schedules.list", input: z.object({}), output: z.array(StoredScheduleSchema) });
export const inspectSchedule = defineRpc({ name: "schedules.inspect", input: idInput, output: StoredScheduleSchema });
export const scheduleLogs = defineRpc({ name: "schedules.logs", input: idInput, output: z.array(ScheduleRunSchema) });
export const pauseSchedule = defineRpc({ name: "schedules.pause", input: idInput, output: StoredScheduleSchema });
export const resumeSchedule = defineRpc({ name: "schedules.resume", input: idInput, output: StoredScheduleSchema });
export const runScheduleOnce = defineRpc({ name: "schedules.run-once", input: idInput, output: StoredScheduleSchema });
export const deleteSchedule = defineRpc({ name: "schedules.delete", input: idInput, output: z.object({ deleted: z.literal(true) }) });
export const updateSchedule = defineRpc({ name: "schedules.update", input: UpdateScheduleInputSchema, output: StoredScheduleSchema });
export const completeSchedulesForAgent = defineRpc({ name: "schedules.complete-for-agent", input: z.object({ agentId: z.string().min(1) }), output: z.object({ completed: z.number().int().nonnegative() }) });
