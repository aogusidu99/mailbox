import type { MetadataRoute } from "next";

/** PWA 清单（/manifest.webmanifest） */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Mailbox",
    short_name: "Mailbox",
    description: "AI 邮件处理工作台",
    start_url: "/mail",
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#171717",
    lang: "zh-CN",
    icons: [{ src: "/icons/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  };
}
