import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Tailwind 클래스 병합 유틸(shadcn 표준). 조건부 클래스 + 충돌 해소. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
