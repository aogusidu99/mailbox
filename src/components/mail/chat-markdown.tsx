"use client";

import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * 渲染「和邮箱对话」里助理回复的 Markdown：支持表格 / 列表 / 链接 / 代码 / 引用。
 * react-markdown 默认不渲染原始 HTML、并会过滤危险 URL（javascript: 等），可安全用于模型输出。
 * 链接一律新标签打开——点邮件链接跳转时不打断当前对话。
 */
export function ChatMarkdown({ content }: { content: string }) {
  return (
    <div className="space-y-2 text-sm leading-relaxed">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener" className="text-primary underline underline-offset-2">
              {children}
            </a>
          ),
          p: ({ children }) => <p className="break-words">{children}</p>,
          ul: ({ children }) => <ul className="list-disc space-y-0.5 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal space-y-0.5 pl-5">{children}</ol>,
          h1: ({ children }) => <h1 className="mt-1 text-base font-semibold">{children}</h1>,
          h2: ({ children }) => <h2 className="mt-1 text-sm font-semibold">{children}</h2>,
          h3: ({ children }) => <h3 className="mt-1 text-sm font-semibold">{children}</h3>,
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          code: ({ children }) => <code className="rounded bg-background/70 px-1 py-0.5 font-mono text-xs">{children}</code>,
          pre: ({ children }) => <pre className="overflow-x-auto rounded bg-background/70 p-2 text-xs">{children}</pre>,
          blockquote: ({ children }) => <blockquote className="border-l-2 border-muted-foreground/30 pl-2 text-muted-foreground">{children}</blockquote>,
          hr: () => <hr className="border-muted-foreground/20" />,
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-xs">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-background/70">{children}</thead>,
          th: ({ children }) => <th className="border border-border px-2 py-1 text-left font-medium">{children}</th>,
          td: ({ children }) => <td className="border border-border px-2 py-1 align-top">{children}</td>,
        }}
      >
        {content}
      </Markdown>
    </div>
  );
}
