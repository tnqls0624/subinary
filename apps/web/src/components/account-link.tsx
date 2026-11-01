"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Settings } from "lucide-react";
import { isUnder } from "@/lib/nav-tabs";
import { cn } from "@/lib/utils";

export function AccountLink() {
  const pathname = usePathname();
  const active = isUnder(pathname, "/more");
  return (
    <Link href="/more" aria-label="설정" aria-current={active ? "page" : undefined}
      className={cn("hover:bg-muted flex size-11 items-center justify-center rounded-full transition-colors", active && "bg-muted")}>
      <Settings className="size-5" aria-hidden="true" />
    </Link>
  );
}
