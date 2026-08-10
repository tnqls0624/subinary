"use client";

import { Check } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * 체크박스 프리미티브 (P3).
 *
 * 원시 `<input type="checkbox">`가 두 화면에 서로 다른 모양으로 흩어져 있었다
 * (거래 상세의 '자동 분류', 합류 화면의 동의). 프리미티브로 모아 색·포커스 링·크기를
 * 토큰에서 가져온다 — 하드코딩된 `size-4`가 다크 모드에서 시스템 기본색으로 튀던
 * 자리다.
 *
 * **Radix를 쓰지 않고 네이티브 input 위에 그린 이유:** 접근성이 원시 input보다
 * 나빠지면 안 된다는 것이 이 작업의 조건이다. 네이티브 input은 `<label>` 감싸기로
 * 연결되고, Space 토글·폼 제출·스크린리더 role/state가 전부 브라우저 것이다. 새
 * 의존성(=락파일 변경)도 만들지 않는다. 모양만 `appearance-none`으로 벗기고 체크
 * 표시를 형제 아이콘으로 그린다(`peer-checked:`).
 *
 * 터치 타깃: 상자 자체는 16px이지만 두 사용처 모두 `<label>`이 문장 전체를 감싸므로
 * 실제 누를 수 있는 영역은 그 줄 전체다. 상자만 단독으로 쓸 때는 호출부가
 * `<label>`이나 패딩으로 44px을 확보해야 한다.
 */
function Checkbox({
  className,
  ...props
}: Omit<React.ComponentProps<"input">, "type">) {
  return (
    <span
      data-slot="checkbox"
      // className은 **바깥 span**에 붙인다 — input은 span을 꽉 채우므로 크기·정렬
      // (`mt-0.5` 같은 것)은 여기서 정해져야 한다.
      // has-[:disabled]: 비활성은 상자와 체크 표시를 함께 흐리게 한다 — 체크 아이콘이
      // input의 형제라 input의 opacity를 물려받지 못한다.
      className={cn(
        "relative inline-flex size-4 shrink-0 items-center justify-center has-[:disabled]:opacity-50",
        className,
      )}
    >
      <input
        type="checkbox"
        className={cn(
          "peer border-input dark:bg-input/30 absolute inset-0 m-0 size-full appearance-none rounded-[4px] border shadow-xs outline-none transition-[color,box-shadow]",
          "checked:bg-primary checked:border-primary",
          "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
          "disabled:cursor-not-allowed",
        )}
        {...props}
      />
      <Check
        aria-hidden="true"
        strokeWidth={3.5}
        className="text-primary-foreground pointer-events-none absolute size-3 opacity-0 transition-opacity peer-checked:opacity-100"
      />
    </span>
  );
}

export { Checkbox };
