"use server";

import { requireUser } from "@/server/auth/session";
import { disconnectGoogle } from "@/server/google/connection";
import { createTask, deleteTask, listAllTasks, updateTask, type TaskInput } from "@/server/google/tasks";

type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string };

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 拉取所有清单的任务（统一视图） */
export async function loadAllTasksAction() {
  return run(async () => {
    const user = await requireUser();
    return listAllTasks(user.id);
  });
}

export async function createTaskAction(listId: string, input: TaskInput) {
  return run(async () => {
    const user = await requireUser();
    if (!input.title.trim()) throw new Error("请填写任务标题");
    return createTask(user.id, listId, input);
  });
}

export async function updateTaskAction(listId: string, taskId: string, patch: Partial<TaskInput> & { completed?: boolean }) {
  return run(async () => {
    const user = await requireUser();
    return updateTask(user.id, listId, taskId, patch);
  });
}

export async function deleteTaskAction(listId: string, taskId: string) {
  return run(async () => {
    const user = await requireUser();
    await deleteTask(user.id, listId, taskId);
  });
}

export async function disconnectGoogleAction() {
  return run(async () => {
    const user = await requireUser();
    await disconnectGoogle(user.id);
  });
}
