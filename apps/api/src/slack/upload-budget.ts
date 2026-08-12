/**
 * 동시 업로드 메모리 예산.
 *
 * ## 왜 필요한가
 *
 * 업로드는 `filePart.toBuffer()`로 파일 **전체를 메모리에** 올린다. 파일 1건의 상한은
 * `main.ts`의 multipart `fileSize`(50MiB)가 막지만, **동시에 몇 개가 올라오는지에는
 * 상한이 없었다.** 네 명이 동시에 50MiB를 올리면 200MiB가 힙에 한꺼번에 뜨고, 그건
 * 사용자 실수 하나 없이도 API를 죽인다.
 *
 * ## 왜 스트리밍이 아니라 예산인가
 *
 * 진짜 스트리밍(multipart → MinIO)은 `PutObject`에 길이를 미리 줘야 하거나
 * `@aws-sdk/lib-storage`의 멀티파트 업로더가 필요하다 — 새 의존성(락파일 변경)이고,
 * 이번 작업의 위험을 저장 계층 재작성까지 넓힌다. PO 판정 Q3-4는 **"전부-buffering
 * 제거 *또는* 동시 업로드 메모리 예산"** 둘 중 하나를 요구했고, 여기서는 후자를 택했다.
 * 그 대신 상한을 **숫자로 못 박고** 초과분은 거절한다 — 조용히 힙을 늘리지 않는다.
 *
 * ## 계약
 *
 * - 예약은 **읽기 전에** 잡는다. 다 읽고 나서 재면 이미 힙에 올라간 뒤다.
 * - 예약 단위는 실제 파일 크기가 아니라 **최악값(파일 1건 상한)**이다. 스트림을 다
 *   읽기 전에는 크기를 모르므로, 모르는 값을 낙관적으로 가정하지 않는다.
 * - 초과하면 429가 아니라 **503 + Retry-After**다. 사용자가 뭔가를 잘못한 게 아니라
 *   서버가 지금 여유가 없는 것이고, 잠시 뒤 그대로 다시 하면 된다.
 * - 해제는 반드시 `finally`에서 한다. 한 번이라도 새면 예산이 영구히 줄어든다.
 */

/**
 * 동시에 메모리에 올릴 수 있는 업로드 총량(bytes).
 *
 * 50MiB(파일 1건 상한) × 3 = 150MiB. 이 앱의 사용자 수(가족 규모)에서 Slack Export를
 * 동시에 셋이 올리는 일은 사실상 없고, 넷째는 잠시 기다렸다 다시 하면 된다. `[가설]`
 * — 운영 동시 업로드 분포는 저장소에 없다(PO 판정 Q3의 "모름").
 */
export const SLACK_UPLOAD_MEMORY_BUDGET_BYTES = 150 * 1024 * 1024;

/**
 * 업로드 1건이 예약하는 크기(bytes). `main.ts`의 multipart `fileSize` 상한과 **같아야
 * 한다** — 둘이 어긋나면 예산이 실제 사용량을 과소평가한다.
 */
export const SLACK_UPLOAD_MAX_FILE_BYTES = 50 * 1024 * 1024;

/** 예산 초과 시 클라이언트에게 권하는 재시도 간격(초). */
export const SLACK_UPLOAD_RETRY_AFTER_SECONDS = 10;

/**
 * 프로세스 전역 예산.
 *
 * 인스턴스 단위인 이유: 막으려는 것이 **이 프로세스의 힙**이다. 여러 인스턴스로
 * 늘리면 각자 자기 힙만 지키면 되고, 그게 맞다(분산 카운터는 여기서 지킬 게 아니다).
 */
export class UploadMemoryBudget {
  private inFlightBytes = 0;

  constructor(
    private readonly budgetBytes: number = SLACK_UPLOAD_MEMORY_BUDGET_BYTES,
    private readonly reservationBytes: number = SLACK_UPLOAD_MAX_FILE_BYTES,
  ) {}

  /** 지금 예약된 바이트 수(관측·테스트용). */
  get reserved(): number {
    return this.inFlightBytes;
  }

  /** 동시에 허용되는 업로드 수. */
  get capacity(): number {
    return Math.floor(this.budgetBytes / this.reservationBytes);
  }

  /**
   * 예산을 잡는다. 여유가 없으면 `null`을 돌려주고, 호출부가 503으로 되돌린다.
   * 성공하면 **반드시 `finally`에서 호출해야 하는 해제 함수**를 준다.
   */
  tryAcquire(): (() => void) | null {
    if (this.inFlightBytes + this.reservationBytes > this.budgetBytes) {
      return null;
    }
    this.inFlightBytes += this.reservationBytes;
    let released = false;
    return () => {
      // 두 번 해제되면 예산이 늘어나 상한이 무의미해진다 — 멱등으로 막는다.
      if (released) return;
      released = true;
      this.inFlightBytes -= this.reservationBytes;
    };
  }
}
