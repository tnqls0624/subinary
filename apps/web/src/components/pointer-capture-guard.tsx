"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · pointer-capture 방어 가드
 *
 * React 19 + Radix 프리미티브(Select/DropdownMenu/Dialog)에서 알려진 레이스:
 * 포인터 up/cancel 타이밍에 따라 캡처가 이미 풀린 상태로 releasePointerCapture가
 * 호출되면 브라우저가 `NotFoundError: No active pointer with the given id is
 * found`를 던진다. 기능엔 무해하지만(해제는 이미 끝난 상태) 콘솔을 더럽힌다.
 *
 * 스펙 의도상 "캡처되지 않은 포인터의 해제"는 no-op이어야 하므로, hasPointerCapture로
 * 먼저 확인하도록 감싼다. setPointerCapture도 같은 계열 오류가 있어 함께 보호한다.
 * 전역 프로토타입을 1회만 패치한다(SSR 무영향 — 클라이언트에서만 실행).
 * ------------------------------------------------------------------------- */
import { useEffect } from "react";

let patched = false;

function patchPointerCapture(): void {
  if (patched || typeof Element === "undefined") return;
  patched = true;

  const proto = Element.prototype;

  const originalRelease = proto.releasePointerCapture;
  proto.releasePointerCapture = function releasePointerCaptureSafe(
    this: Element,
    pointerId: number,
  ): void {
    // 캡처 중이 아니면 조용히 무시(브라우저 NotFoundError 방지).
    if (typeof this.hasPointerCapture === "function" && !this.hasPointerCapture(pointerId)) {
      return;
    }
    try {
      originalRelease.call(this, pointerId);
    } catch {
      // 레이스로 실패해도 무해(이미 해제된 상태).
    }
  };

  const originalSet = proto.setPointerCapture;
  proto.setPointerCapture = function setPointerCaptureSafe(
    this: Element,
    pointerId: number,
  ): void {
    try {
      originalSet.call(this, pointerId);
    } catch {
      // 대상이 이미 사라졌거나 포인터가 유효하지 않으면 무시.
    }
  };
}

/** 마운트 시 1회 전역 패치. 렌더 출력은 없다. */
export function PointerCaptureGuard(): null {
  useEffect(() => {
    patchPointerCapture();
  }, []);
  return null;
}
