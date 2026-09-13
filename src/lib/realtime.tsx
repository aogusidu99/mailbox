"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { toast } from "sonner";
import type { RealtimeEventDto } from "./api-types";

/**
 * 订阅 /api/events（SSE），根据事件失效相关查询，让列表 / 侧栏自动刷新。
 * 浏览器 EventSource 断线会自动重连。
 */
export function useRealtime(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    const es = new EventSource("/api/events");
    es.onmessage = (e) => {
      let event: RealtimeEventDto;
      try {
        event = JSON.parse(e.data) as RealtimeEventDto;
      } catch {
        return;
      }
      switch (event.type) {
        case "folder":
          void queryClient.invalidateQueries({ queryKey: ["sidebar"] });
          void queryClient.invalidateQueries({
            queryKey: event.folderId ? ["messages", event.accountId, event.folderId] : ["messages", event.accountId],
          });
          break;
        case "account":
          void queryClient.invalidateQueries({ queryKey: ["sidebar"] });
          break;
        case "message":
          void queryClient.invalidateQueries({ queryKey: ["message", event.messageId] });
          void queryClient.invalidateQueries({ queryKey: ["messages", event.accountId, event.folderId] });
          break;
        case "outbox":
          if (event.status === "failed") toast.error(`同步到服务器失败：${event.error ?? "未知错误"}`);
          void queryClient.invalidateQueries({ queryKey: ["messages", event.accountId] });
          void queryClient.invalidateQueries({ queryKey: ["sidebar"] });
          break;
      }
    };
    return () => es.close();
  }, [queryClient]);
}

/** 挂载即订阅，放在已登录布局里。 */
export function RealtimeListener() {
  useRealtime();
  return null;
}
