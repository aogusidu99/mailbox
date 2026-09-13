import type { MessageDetail, MessageListResponse, SidebarData, ThreadListResponse } from "./api-types";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) {
    let message = `${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export const api = {
  sidebar: () => getJson<SidebarData>("/api/mail/sidebar"),
  messages: (params: { accountId: string; folderId: string; cursor?: string | null; q?: string; unread?: boolean; flagged?: boolean; category?: string }) => {
    const sp = new URLSearchParams({ accountId: params.accountId, folderId: params.folderId });
    if (params.cursor) sp.set("cursor", params.cursor);
    if (params.q) sp.set("q", params.q);
    if (params.unread) sp.set("unread", "1");
    if (params.flagged) sp.set("flagged", "1");
    if (params.category) sp.set("category", params.category);
    return getJson<MessageListResponse>(`/api/mail/messages?${sp.toString()}`);
  },
  message: (id: string, opts: { remote?: boolean } = {}) =>
    getJson<MessageDetail>(`/api/mail/messages/${encodeURIComponent(id)}${opts.remote ? "?remote=1" : ""}`),
  threads: (params: { accountId: string; folderId: string; q?: string; unread?: boolean; flagged?: boolean; category?: string }) => {
    const sp = new URLSearchParams({ accountId: params.accountId, folderId: params.folderId });
    if (params.q) sp.set("q", params.q);
    if (params.unread) sp.set("unread", "1");
    if (params.flagged) sp.set("flagged", "1");
    if (params.category) sp.set("category", params.category);
    return getJson<ThreadListResponse>(`/api/mail/threads?${sp.toString()}`);
  },
};
