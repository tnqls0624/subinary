"use client";
import type { InputHTMLAttributes, ReactNode } from "react";

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: ReactNode;
  error?: string | null;
}

/** 라벨 + input + (에러/힌트) 조합의 최소 폼 필드. */
export function Field({
  label,
  hint,
  error,
  id,
  name,
  className,
  ...rest
}: FieldProps) {
  const inputId = id ?? name;
  const inputClasses = ["field-input"];
  if (error) inputClasses.push("field-input-error");
  if (className) inputClasses.push(className);
  return (
    <label className="field" htmlFor={inputId}>
      <span className="field-label">{label}</span>
      <input
        id={inputId}
        name={name}
        className={inputClasses.join(" ")}
        aria-invalid={error ? true : undefined}
        {...rest}
      />
      {error ? (
        <span className="field-error">{error}</span>
      ) : hint ? (
        <span className="field-hint">{hint}</span>
      ) : null}
    </label>
  );
}
