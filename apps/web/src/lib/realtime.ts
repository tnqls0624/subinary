/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 실시간 SSE 클라이언트 (fetch 기반)
 *
 * GET /v1/realtime/stream 을 구독해 서버의 무효화 힌트를 받는다. EventSource는
 * Authorization 헤더를 못 실으므로 fetch + ReadableStream으로 SSE를 직접 파싱한다
 * (Bearer 인증을 기존 authedFetch 패턴 그대로 유지 — 별도 티켓/쿠키 불필요).
 *
 * 파서는 SSE 프레이밍의 부분집합만 다룬다: `event:`/`data:` 라인, 빈 줄 구분.
 * 서버는 'hint'(무효화 힌트)와 'heartbeat'(유휴 절단 회피)만 보낸다.
 * ------------------------------------------------------------------------- */

/** 서버가 보내는 SSE 이벤트 1건(파싱 결과). */
export interface SseMessage {
  event: string;
  data: string;
}

/**
 * SSE 응답 본문을 읽어 이벤트마다 콜백을 호출한다. 스트림이 정상 종료(서버 최대
 * 수명 도달)하거나 네트워크 오류로 끊기면 반환/throw 한다 — 재연결은 호출부 몫.
 */
export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onMessage: (message: SseMessage) => void,
  signal: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || signal.aborted) return;
      buffer += decoder.decode(value, { stream: true });

      // 이벤트 경계(빈 줄)로 분리. 마지막 조각은 다음 청크와 이어붙인다.
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const message = parseFrame(frame);
        if (message) onMessage(message);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** SSE 프레임 1개(`event:`/`data:` 라인 묶음) → 메시지. 주석/무효 프레임은 null. */
function parseFrame(frame: string): SseMessage | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
    // 그 외(id:, retry:, ':' 주석)는 무시.
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

/** 재연결 백오프(ms): 1s → 2s → 4s … 최대 30s. */
export function nextBackoff(current: number): number {
  return Math.min(Math.max(current, 1_000) * 2, 30_000);
}
