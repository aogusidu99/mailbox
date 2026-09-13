import { eq, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { folders, mailAccounts } from "@/db/schema";
import { enqueueSyncFolder } from "@/server/jobs/queues";
import { createProviderForAccount } from "@/server/providers/factory";
import { describeImapError } from "@/server/providers/imap";

/**
 * IMAP IDLE 管理器：为每个启用的账号保持一条对 INBOX 的长连接，
 * 收到变化通知后（去抖 1.5s）把该文件夹的同步任务入队；断线按指数退避重连。
 */

interface Watcher {
  accountId: string;
  email: string;
  stop?: () => Promise<void>;
  retryTimer?: NodeJS.Timeout;
  debounce?: NodeJS.Timeout;
  attempts: number;
  stopping: boolean;
  connected: boolean;
  lastError?: string;
}

export interface IdleStatus {
  accountId: string;
  email: string;
  connected: boolean;
  attempts: number;
  lastError?: string;
}

class IdleManager {
  private watchers = new Map<string, Watcher>();

  status(): IdleStatus[] {
    return [...this.watchers.values()].map((w) => ({
      accountId: w.accountId,
      email: w.email,
      connected: w.connected,
      attempts: w.attempts,
      lastError: w.lastError,
    }));
  }

  /** 与数据库中的账号列表对齐：新账号开始监听，删除的账号停止监听。 */
  async reconcile(): Promise<void> {
    const db = await getDb();
    const accounts = await db.query.mailAccounts.findMany({ where: ne(mailAccounts.syncStatus, "disabled") });
    const wanted = new Set(accounts.map((a) => a.id));
    for (const account of accounts) {
      if (!this.watchers.has(account.id)) {
        const w: Watcher = { accountId: account.id, email: account.email, attempts: 0, stopping: false, connected: false };
        this.watchers.set(account.id, w);
        void this.connect(w);
      }
    }
    for (const id of [...this.watchers.keys()]) {
      if (!wanted.has(id)) await this.stop(id);
    }
  }

  private async connect(w: Watcher): Promise<void> {
    if (w.stopping) return;
    try {
      const db = await getDb();
      const account = await db.query.mailAccounts.findFirst({ where: eq(mailAccounts.id, w.accountId) });
      if (!account) return;
      const inbox = await db.query.folders.findFirst({ where: eq(folders.accountId, account.id) && eq(folders.role, "inbox") });
      const path = inbox?.path ?? "INBOX";
      const provider = await createProviderForAccount(account);
      if (!provider.idle) return;
      w.stop = await provider.idle(path, {
        onChange: () => this.onChange(w, path),
        onClose: (err) => {
          w.connected = false;
          w.lastError = err ? describeImapError(err) : undefined;
          this.scheduleReconnect(w);
        },
      });
      w.connected = true;
      w.attempts = 0;
      w.lastError = undefined;
      console.log(`[idle] ${account.email} 已监听 ${path}`);
    } catch (err) {
      w.connected = false;
      w.lastError = describeImapError(err);
      console.warn(`[idle] ${w.email} 连接失败:`, w.lastError);
      this.scheduleReconnect(w);
    }
  }

  private onChange(w: Watcher, path: string): void {
    if (w.debounce) clearTimeout(w.debounce);
    w.debounce = setTimeout(() => {
      enqueueSyncFolder(w.accountId, { folderPath: path }).catch((err) => console.warn("[idle] 入队失败:", err));
    }, 1500);
  }

  private scheduleReconnect(w: Watcher): void {
    if (w.stopping) return;
    w.stop = undefined;
    w.attempts += 1;
    const delay = Math.min(5 * 60_000, 5_000 * 2 ** Math.min(6, w.attempts - 1));
    if (w.retryTimer) clearTimeout(w.retryTimer);
    w.retryTimer = setTimeout(() => void this.connect(w), delay);
    w.retryTimer.unref?.();
  }

  async stop(accountId: string): Promise<void> {
    const w = this.watchers.get(accountId);
    if (!w) return;
    w.stopping = true;
    if (w.retryTimer) clearTimeout(w.retryTimer);
    if (w.debounce) clearTimeout(w.debounce);
    this.watchers.delete(accountId);
    try {
      await w.stop?.();
    } catch {
      /* ignore */
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.watchers.keys()].map((id) => this.stop(id)));
  }
}

const globalRef = globalThis as unknown as { __mailboxIdleManager?: IdleManager };

export function getIdleManager(): IdleManager {
  if (!globalRef.__mailboxIdleManager) globalRef.__mailboxIdleManager = new IdleManager();
  return globalRef.__mailboxIdleManager;
}
