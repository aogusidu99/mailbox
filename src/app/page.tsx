import { redirect } from "next/navigation";

/** 根路径直接进入邮件区（未登录会被 /mail 的布局重定向到 /login）。 */
export default function Home() {
  redirect("/mail");
}
