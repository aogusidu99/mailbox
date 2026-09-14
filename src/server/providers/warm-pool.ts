import type { MailAccount } from "@/db/schema";
import { createProviderForAccount } from "./factory";
import type { MailProvider } from "./types";

/**
 * 账号级「热连接」池：为用户实时触发的按需读取（打开邮件正文 / 下载附件）复用一条 IMAP 连接，
 * 避免每次都重新握手 + 登录——香港服务器↔邮箱服务器往返下，一次冷连接握手要 1~3 秒。
 *
 * 设计取舍（刻意保持简单，规避共享连接的并发风险）：
 * - 每个账号至多保留 1 条空闲热连接，且「独占复用」：只有它空闲时才被下一个请求取走。
 * - 若热连接正忙（并发请求撞上），后来的请求各自开一次性连接，用完再尝试存回池中。
 * - 仅用于幂等只读操作：复用连接出错时，会丢弃它并用全新连接重试一次。
 */

/** 空闲热连接的保活时长；超时无人复用则自动断开。 */
const IDLE_MS = 45_000;

interface Slot {
  provider: MailProvider;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

/** 每账号至多一条：空闲、可被复用的热连接。 */
const idlePool = new Map<string, Slot>();

/** 取走某账号的空闲热连接（存在且仍可用时）。 */
function takeIdle(accountId: string): MailProvider | null {
  const slot = idlePool.get(accountId);
  if (!slot) return null;
  idlePool.delete(accountId);
  if (slot.idleTimer) clearTimeout(slot.idleTimer);
  if (!slot.provider.usable) {
    void slot.provider.disconnect().catch(() => {});
    return null;
  }
  return slot.provider;
}

/** 把用完且仍健康的连接存回池，保活 IDLE_MS 后自动断开。 */
function keepWarm(accountId: string, provider: MailProvider): void {
  // 已失活，或池里已有一条（本条多余）→ 直接断开，池内始终至多一条
  if (!provider.usable || idlePool.has(accountId)) {
    void provider.disconnect().catch(() => {});
    return;
  }
  const idleTimer = setTimeout(() => {
    const slot = idlePool.get(accountId);
    if (slot && slot.provider === provider) {
      idlePool.delete(accountId);
      void provider.disconnect().catch(() => {});
    }
  }, IDLE_MS);
  // 不因这个保活定时器阻止进程退出
  idleTimer.unref?.();
  idlePool.set(accountId, { provider, idleTimer });
}

/** 新开一条连接执行操作，成功后存回池供下次复用；失败则断开。 */
async function runFresh<T>(account: MailAccount, fn: (provider: MailProvider) => Promise<T>): Promise<T> {
  const provider = await createProviderForAccount(account);
  await provider.connect();
  try {
    const result = await fn(provider);
    keepWarm(account.id, provider);
    return result;
  } catch (err) {
    void provider.disconnect().catch(() => {});
    throw err;
  }
}

/**
 * 用一条（尽量复用的）连接执行只读操作。
 * 复用连接若出错（可能已被服务器断开），丢弃后用全新连接重试一次；
 * 因此 fn 必须是幂等的（正文/附件拉取都是纯读）。
 */
export async function withWarmProvider<T>(account: MailAccount, fn: (provider: MailProvider) => Promise<T>): Promise<T> {
  const reused = takeIdle(account.id);
  if (reused) {
    try {
      const result = await fn(reused);
      keepWarm(account.id, reused);
      return result;
    } catch {
      void reused.disconnect().catch(() => {});
      return runFresh(account, fn); // 复用连接可能已失活，全新连接重试一次
    }
  }
  return runFresh(account, fn);
}
