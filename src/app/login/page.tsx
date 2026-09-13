import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "登录 · Mailbox" };

export default async function LoginPage() {
  const session = await auth();
  if (session?.user) redirect("/mail");

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/40 p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Mailbox</CardTitle>
          <CardDescription>使用管理员账号登录（见 .env.local 中的 ADMIN_EMAIL / ADMIN_PASSWORD）</CardDescription>
        </CardHeader>
        <CardContent>
          <LoginForm />
        </CardContent>
      </Card>
    </main>
  );
}
