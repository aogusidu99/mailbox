import { EventEmitter } from "node:events";

/**
 * 进程内实时事件总线：worker 同步完成后 publish，SSE 路由（/api/events）订阅并推给浏览器。
 * Web 与 worker 同进程，因此不需要 LISTEN/NOTIFY；拆成独立进程时把这里换成数据库通知即可。
 */

export type RealtimeEvent =
  | { type: "folder"; accountId: string; folderId?: string; folderPath?: string }
  | { type: "account"; accountId: string }
  | { type: "message"; accountId: string; folderId: string; messageId: string }
  | { type: "outbox"; accountId: string; opId: string; status: string; error?: string };

const globalRef = globalThis as unknown as { __mailboxBus?: EventEmitter };

function emitter(): EventEmitter {
  if (!globalRef.__mailboxBus) {
    globalRef.__mailboxBus = new EventEmitter();
    globalRef.__mailboxBus.setMaxListeners(200);
  }
  return globalRef.__mailboxBus;
}

export function publish(event: RealtimeEvent): void {
  emitter().emit("event", event);
}

export function subscribe(listener: (event: RealtimeEvent) => void): () => void {
  const e = emitter();
  e.on("event", listener);
  return () => e.off("event", listener);
}
