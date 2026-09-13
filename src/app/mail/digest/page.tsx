import type { Metadata } from "next";
import Link from "next/link";
import { dailyDigest, todayKey } from "@/server/ai/assist";
import { requireUserPage } from "@/server/auth/session";
import { DigestView } from "./digest-view";

export const metadata: Metadata = { title: "每日摘要 · Mailbox" };

export default async function DigestPage(props: PageProps<"/mail/digest">) {
  const user = await requireUserPage();
  const sp = await props.searchParams;
  const dayParam = typeof sp.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.day) ? sp.day : todayKey();
  let digest: Awaited<ReturnType<typeof dailyDigest>>;
  let error: string | null = null;
  try {
    digest = await dailyDigest(user.id, dayParam);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    digest = { items: [], content: null, cached: false };
  }
  const prev = shiftDay(dayParam, -1);
  const next = shiftDay(dayParam, 1);
  return (
    <main className="mx-auto w-full max-w-3xl space-y-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">每日摘要 · {dayParam}</h1>
        <div className="flex items-center gap-2 text-sm">
          <Link className="rounded-md border px-2 py-1 hover:bg-muted" href={`/mail/digest?day=${prev}`}>
            ← {prev}
          </Link>
          <Link className="rounded-md border px-2 py-1 hover:bg-muted" href={`/mail/digest?day=${next}`}>
            {next} →
          </Link>
        </div>
      </div>
      <DigestView day={dayParam} items={digest.items} content={digest.content} model={digest.model} error={error} />
    </main>
  );
}

function shiftDay(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00`);
  d.setDate(d.getDate() + delta);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
