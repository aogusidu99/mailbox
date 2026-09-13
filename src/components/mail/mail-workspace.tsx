"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Mail } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useState, useTransition } from "react";
import { toast } from "sonner";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import type { MessageListItem } from "@/lib/api-types";
import { useIsMobile } from "@/lib/use-media-query";
import { MessageList } from "./message-list";
import { MessageView } from "./message-view";

/**
 * 三栏中的「列表 + 阅读」两栏。选中邮件记录在 ?m= 中，便于刷新与分享链接。
 */
export function MailWorkspace({
  accountId,
  folderId,
  folderName,
  onRefresh,
  listHeaderExtra,
  viewToolbar,
  onOpenMessage,
  onServerSearch,
}: {
  accountId: string;
  folderId: string;
  folderName: string;
  onRefresh?: () => Promise<{ ok: boolean; error?: string }>;
  listHeaderExtra?: React.ReactNode;
  viewToolbar?: Parameters<typeof MessageView>[0]["toolbar"];
  onOpenMessage?: (item: MessageListItem) => void;
  onServerSearch?: (q: string) => Promise<void>;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const selectedId = searchParams.get("m");
  const queryClient = useQueryClient();
  const [refreshing, startRefresh] = useTransition();
  const [mobileShowView, setMobileShowView] = useState(Boolean(selectedId));
  const isMobile = useIsMobile();

  const select = useCallback(
    (item: MessageListItem) => {
      const sp = new URLSearchParams(searchParams.toString());
      sp.set("m", item.id);
      router.replace(`${pathname}?${sp.toString()}`, { scroll: false });
      setMobileShowView(true);
      onOpenMessage?.(item);
    },
    [router, pathname, searchParams, onOpenMessage],
  );

  const back = useCallback(() => {
    const sp = new URLSearchParams(searchParams.toString());
    sp.delete("m");
    router.replace(sp.size ? `${pathname}?${sp.toString()}` : pathname, { scroll: false });
    setMobileShowView(false);
  }, [router, pathname, searchParams]);

  const refresh = () => {
    startRefresh(async () => {
      if (onRefresh) {
        const r = await onRefresh();
        if (!r.ok) toast.error(r.error ?? "刷新失败");
      }
      await queryClient.invalidateQueries({ queryKey: ["messages", accountId, folderId] });
      await queryClient.invalidateQueries({ queryKey: ["sidebar"] });
    });
  };

  const list = (
    <MessageList
      accountId={accountId}
      folderId={folderId}
      folderName={folderName}
      selectedId={selectedId}
      onSelect={select}
      onRefresh={refresh}
      refreshing={refreshing}
      headerExtra={listHeaderExtra}
      onServerSearch={onServerSearch}
    />
  );

  // 移动端：列表 / 阅读二选一（只渲染其中一个，避免正文重复加载）
  if (isMobile) {
    if (mobileShowView && selectedId) {
      return (
        <div className="flex h-full flex-col">
          <button type="button" onClick={back} className="border-b px-3 py-2 text-left text-sm text-primary">
            ← 返回列表
          </button>
          <div className="min-h-0 flex-1">
            <MessageView key={selectedId} messageId={selectedId} toolbar={viewToolbar} />
          </div>
        </div>
      );
    }
    return <div className="h-full">{list}</div>;
  }

  // 桌面：可拖拽两栏
  return (
    <ResizablePanelGroup orientation="horizontal" className="h-full">
      <ResizablePanel defaultSize="38%" minSize="25%">
        {list}
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel minSize="30%">
        {selectedId ? (
          <MessageView key={selectedId} messageId={selectedId} toolbar={viewToolbar} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            <Mail className="size-8 opacity-40" />
            选择一封邮件查看
          </div>
        )}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
