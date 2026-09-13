"use client";

import { useState } from "react";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import type { SidebarData } from "@/lib/api-types";
import { Sidebar } from "./sidebar";

/** 移动端：把侧栏放进抽屉。 */
export function MobileSidebar({
  initial,
  userEmail,
  signOutAction,
  children,
}: {
  initial: SidebarData;
  userEmail: string;
  signOutAction: () => Promise<void>;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger render={<button type="button" className="inline-flex size-8 items-center justify-center rounded-md hover:bg-muted" aria-label="菜单" />}>
        {children}
      </SheetTrigger>
      <SheetContent side="left" className="w-72 p-0">
        <SheetTitle className="sr-only">导航</SheetTitle>
        <Sidebar initial={initial} userEmail={userEmail} signOutAction={signOutAction} onNavigate={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}
