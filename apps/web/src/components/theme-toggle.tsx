"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** 라이트/다크/시스템 테마 토글(next-themes). */
export function ThemeToggle() {
  const { setTheme } = useTheme();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="테마 전환">
          <Sun className="size-4 scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90" />
          <Moon className="absolute size-4 scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => setTheme("light")}>
          <Sun /> 라이트
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme("dark")}>
          <Moon /> 다크
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme("system")}>
          <Monitor /> 시스템
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Appearance is an occasional setting, not a global header action. */
export function ThemeSettingRow() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <label className="flex min-h-16 items-center gap-3 border-t px-4 py-3">
      <span className="bg-muted text-muted-foreground flex size-10 shrink-0 items-center justify-center rounded-xl"><Monitor className="size-5" aria-hidden="true" /></span>
      <span className="min-w-0 flex-1 text-[15px] font-medium">화면 모드</span>
      <select aria-label="화면 모드" className="border-input bg-card min-h-11 min-w-0 max-w-[48%] rounded-lg border px-2 text-sm" value={mounted ? theme ?? "system" : "system"} disabled={!mounted} onChange={(event) => setTheme(event.target.value)}>
        <option value="system">기기 설정</option>
        <option value="light">밝게</option>
        <option value="dark">어둡게</option>
      </select>
    </label>
  );
}
