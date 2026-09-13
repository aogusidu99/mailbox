import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getServerDict } from "@/lib/locale-server";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "登录 · Mailbox" };

export default async function LoginPage() {
  const session = await auth();
  if (session?.user) redirect("/mail");
  const t = (await getServerDict()).login;

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/40 p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">{t.title}</CardTitle>
          <CardDescription>{t.description}</CardDescription>
        </CardHeader>
        <CardContent>
          <LoginForm />
        </CardContent>
      </Card>
    </main>
  );
}
