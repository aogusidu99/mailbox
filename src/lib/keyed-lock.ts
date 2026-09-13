/**
 * 进程内按 key 串行化的互斥锁：同一账号 / 文件夹的同步任务不并发执行。
 */
const chains = new Map<string, Promise<unknown>>();

export async function withKeyedLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = prev.then(() => gate);
  chains.set(key, next);
  await prev.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (chains.get(key) === next) chains.delete(key);
  }
}
