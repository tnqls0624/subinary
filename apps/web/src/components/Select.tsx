"use client";
import type { SelectHTMLAttributes } from "react";

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  options: ReadonlyArray<SelectOption>;
  /** 빈 값('') 옵션 라벨. 지정 시 맨 위에 표시. */
  placeholder?: string;
}

/** 최소 스타일 select. 옵션은 `{value,label}` 배열로 전달. */
export function Select({
  options,
  placeholder,
  className,
  ...rest
}: SelectProps) {
  return (
    <select className={["select", className].filter(Boolean).join(" ")} {...rest}>
      {placeholder !== undefined ? (
        <option value="">{placeholder}</option>
      ) : null}
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
