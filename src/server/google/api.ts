import { getAccessToken } from "./connection";

/**
 * Google REST API 的薄封装：注入 access token，401 时强制刷新并重试一次，统一解析错误。
 */

function authInit(init: RequestInit | undefined, token: string): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return { ...init, headers, signal: init?.signal ?? AbortSignal.timeout(20_000) };
}

function parseError(status: number, text: string): string {
  try {
    const json = JSON.parse(text) as { error?: { message?: string } | string };
    const msg = typeof json.error === "string" ? json.error : json.error?.message;
    if (msg) return msg;
  } catch {
    /* 非 JSON，原样截断 */
  }
  return text.slice(0, 200) || `HTTP ${status}`;
}

/** 调用一个 Google API 端点；返回解析后的 JSON（204 返回 undefined）。 */
export async function googleFetch<T = unknown>(userId: string, url: string, init?: RequestInit): Promise<T> {
  let token = await getAccessToken(userId);
  let res = await fetch(url, authInit(init, token));
  if (res.status === 401) {
    token = await getAccessToken(userId, { force: true });
    res = await fetch(url, authInit(init, token));
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Google API 调用失败（${res.status}）：${parseError(res.status, text)}`);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}
