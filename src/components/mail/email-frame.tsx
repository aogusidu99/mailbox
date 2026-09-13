"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * 在 sandbox iframe 中渲染已清洗的邮件 HTML。
 * - 不允许脚本；CSP 再禁一次；
 * - 高度跟随内容自动调整；
 * - 链接在新窗口打开。
 */
export function EmailFrame({ html, className }: { html: string; className?: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(200);

  const srcDoc = useMemo(
    () => `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline'; font-src data:;">
<base target="_blank">
<style>
  html, body { margin: 0; padding: 0; }
  body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif; font-size: 14px; line-height: 1.6; color: #171717; padding: 12px 16px; word-break: break-word; overflow-wrap: anywhere; }
  img { max-width: 100%; height: auto; }
  table { max-width: 100%; }
  pre { white-space: pre-wrap; }
  blockquote { border-left: 3px solid #d4d4d4; margin: 8px 0; padding-left: 12px; color: #525252; }
  a { color: #2563eb; }
</style>
</head>
<body>${html}</body>
</html>`,
    [html],
  );

  const measure = useCallback(() => {
    const doc = ref.current?.contentDocument;
    if (!doc?.body) return;
    const h = Math.max(doc.body.scrollHeight, doc.documentElement?.scrollHeight ?? 0);
    if (h > 0) setHeight(Math.min(h + 24, 20_000));
  }, []);

  useEffect(() => {
    const t1 = setTimeout(measure, 100);
    const t2 = setTimeout(measure, 800);
    const t3 = setTimeout(measure, 2500);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, [measure, srcDoc]);

  return (
    <iframe
      ref={ref}
      title="邮件正文"
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={srcDoc}
      onLoad={measure}
      className={className}
      style={{ width: "100%", height, border: 0, display: "block", background: "#fff" }}
    />
  );
}
