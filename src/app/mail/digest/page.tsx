import type { Metadata } from "next";
import { loadDigest, todayKey, type DigestKind } from "@/server/ai/digest";
import { requireUserPage } from "@/server/auth/session";
import { DigestView } from "./digest-view";

export const metadata: Metadata = { title: "摘要与处理台 · Mailbox" };

const KINDS: DigestKind[] = ["day", "week", "month", "since", "custom"];

export default async function DigestPage(props: PageProps<"/mail/digest">) {
  const user = await requireUserPage();
  const sp = await props.searchParams;
  const kind = (typeof sp.kind === "string" && KINDS.includes(sp.kind as DigestKind) ? sp.kind : "day") as DigestKind;
  const day = typeof sp.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.day) ? sp.day : todayKey();
  const from = typeof sp.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.from) ? sp.from : undefined;
  const to = typeof sp.to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.to) ? sp.to : undefined;

  let error: string | null = null;
  let digest: Awaited<ReturnType<typeof loadDigest>>;
  try {
    digest = await loadDigest(user.id, kind, { day, from, to });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    digest = { range: { kind, fromTs: new Date(), toTs: new Date(), periodKey: "", label: "" }, items: [], content: null, plan: [], model: null, cached: false };
  }

  return (
    <main className="mx-auto w-full max-w-3xl p-4 md:p-6">
      <DigestView
        key={digest.range.periodKey}
        kind={kind}
        day={day}
        from={from}
        to={to}
        periodKey={digest.range.periodKey}
        label={digest.range.label}
        items={digest.items}
        content={digest.content}
        plan={digest.plan}
        model={digest.model}
        error={error}
      />
    </main>
  );
}
