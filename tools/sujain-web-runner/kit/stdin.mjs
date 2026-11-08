/**
 * 러너 키트: stdin 에서 작업 JSON 하나를 읽는다. 브랜드 무관이며 playwright-core 를 import 하지 않는다.
 * 원문(자격 증명이 든 문자열)은 이 함수 밖으로 내보내지 않고, 오류에도 싣지 않는다.
 */

const defaultError = (code) => Object.assign(new Error('Runner job was rejected'), { code });

/**
 * maxBytes 를 넘거나, JSON 이 깨졌거나, validate 가 던지면 onError('operation_unknown') 가 돌려준 오류를 던진다.
 * onReadComplete 는 끝까지 읽은 뒤 해석 직전에 부른다 — 진입 파일이 진단 stage 를 'stdin' 에서 다음으로
 * 넘기는 자리다(넘침은 읽는 단계, 깨진 JSON 은 검증 단계로 남는다).
 */
export async function readJobJson(stream, {
  maxBytes = 8192,
  onError = defaultError,
  onReadComplete,
  validate = (value) => value,
} = {}) {
  let input = '';
  for await (const chunk of stream) {
    input += chunk.toString('utf8');
    if (Buffer.byteLength(input, 'utf8') > maxBytes) throw onError('operation_unknown');
  }
  onReadComplete?.();
  try {
    return validate(JSON.parse(input));
  } catch {
    throw onError('operation_unknown');
  }
}
