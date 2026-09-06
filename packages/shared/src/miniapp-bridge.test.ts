/**
 * 미니앱 브릿지 계약 — 호스트가 미니앱을 믿지 않는다는 것을 고정한다.
 *
 * 미니앱은 `<iframe sandbox="allow-scripts">` 안에서 돌고 호스트의 쿠키·DOM에 접근할
 * 수 없다. 그래서 미니앱이 할 수 있는 것은 **브릿지로 요청하는 것뿐**이고, 이 파일의
 * 검증이 그 관문이다. 여기가 뚫리면 격리가 무의미해진다.
 */
import { describe, expect, it } from 'vitest';

import {
  MINIAPP_BRIDGE_VERSION,
  checkMiniappRequest,
  isMiniappMethod,
  isMiniappPermission,
  isMiniappRequest,
  isMiniappResponse,
  miniappError,
  miniappOk,
  permissionForMethod,
  type MiniappRequest,
} from './miniapp-bridge.js';

const req = (over: Partial<MiniappRequest> = {}): MiniappRequest => ({
  v: MINIAPP_BRIDGE_VERSION,
  kind: 'request',
  requestId: 'r1',
  method: 'host.info',
  ...over,
});

describe('isMiniappRequest — postMessage는 누구나 보낸다', () => {
  it('올바른 요청을 통과시킨다', () => {
    expect(isMiniappRequest(req())).toBe(true);
  });

  it.each([
    ['null', null],
    ['문자열', 'request'],
    ['숫자', 42],
    ['kind 없음', { v: 1, requestId: 'r1', method: 'host.info' }],
    ['kind가 response', { ...req(), kind: 'response' }],
    ['requestId 없음', { v: 1, kind: 'request', method: 'host.info' }],
    ['requestId가 빈 문자열', { ...req(), requestId: '' }],
    ['requestId가 숫자', { ...req(), requestId: 1 }],
    ['method 없음', { v: 1, kind: 'request', requestId: 'r1' }],
    ['params가 배열이 아닌 원시값', { ...req(), params: 'x' }],
  ])('%s는 거절한다', (_label, value) => {
    expect(isMiniappRequest(value)).toBe(false);
  });

  it('params가 없어도 요청이다', () => {
    const { params: _drop, ...withoutParams } = req({ params: {} });
    expect(isMiniappRequest(withoutParams)).toBe(true);
  });
});

describe('checkMiniappRequest — 검증 순서', () => {
  it('권한이 있으면 통과한다', () => {
    expect(
      checkMiniappRequest(req({ method: 'spend.summary' }), ['spend.summary']),
    ).toEqual({ ok: true, method: 'spend.summary' });
  });

  it('버전이 다르면 거절한다', () => {
    // 미니앱은 호스트와 따로 배포되므로 버전이 어긋난 채 만나는 일이 반드시 생긴다.
    // 조용히 오작동하는 것보다 명확히 거절하는 편이 낫다.
    const check = checkMiniappRequest(req({ v: 999 }), []);
    expect(check).toMatchObject({ ok: false, code: 'version_mismatch' });
  });

  it('버전을 메서드보다 먼저 본다', () => {
    // 버전이 다르면 메서드 목록 자체가 다를 수 있다.
    const check = checkMiniappRequest(req({ v: 999, method: '없는메서드' }), []);
    expect(check).toMatchObject({ code: 'version_mismatch' });
  });

  it('없는 메서드는 unknown_method다 — permission_denied가 아니다', () => {
    // 권한을 먼저 보면 개발자가 오타를 권한 문제로 오해한다.
    const check = checkMiniappRequest(req({ method: 'spend.everything' }), []);
    expect(check).toMatchObject({ ok: false, code: 'unknown_method' });
  });

  it('선언하지 않은 권한이 필요하면 거절한다', () => {
    const check = checkMiniappRequest(req({ method: 'spend.summary' }), []);
    expect(check).toMatchObject({ ok: false, code: 'permission_denied' });
  });

  it('다른 권한을 갖고 있어도 필요한 권한이 없으면 거절한다', () => {
    const check = checkMiniappRequest(req({ method: 'spend.summary' }), [
      'category.list',
    ]);
    expect(check).toMatchObject({ ok: false, code: 'permission_denied' });
  });
});

describe('권한 없이 쓸 수 있는 메서드', () => {
  it('자기 상태 저장은 권한을 요구하지 않는다', () => {
    // 미니앱 자기 상태이고 호스트가 미니앱 키로 격리한다. 권한을 요구하면 순수
    // 게임도 선언을 해야 하는데, 그 선언은 아무것도 막지 못하면서 마찰만 만든다.
    for (const m of ['state.get', 'state.set', 'state.remove', 'host.info'] as const) {
      expect(permissionForMethod(m)).toBeNull();
      expect(checkMiniappRequest(req({ method: m }), [])).toMatchObject({
        ok: true,
      });
    }
  });

  it('지출·가맹점·카테고리는 권한을 요구한다', () => {
    for (const m of ['spend.summary', 'merchant.list', 'category.list'] as const) {
      expect(permissionForMethod(m)).not.toBeNull();
    }
  });
});

describe('메서드·권한 목록', () => {
  it('알려진 것만 인정한다', () => {
    expect(isMiniappMethod('spend.summary')).toBe(true);
    expect(isMiniappMethod('spend.transactions')).toBe(false);
    expect(isMiniappPermission('spend.summary')).toBe(true);
    expect(isMiniappPermission('spend.write')).toBe(false);
  });

  it('개별 거래를 주는 메서드가 없다', () => {
    // 권한은 넓히기는 쉽고 좁히기는 불가능하다(이미 그 권한으로 만든 미니앱이 깨진다).
    // 지금은 집계까지만 연다.
    expect(isMiniappMethod('transaction.list')).toBe(false);
    expect(isMiniappMethod('transaction.get')).toBe(false);
  });
});

describe('응답 만들기', () => {
  it('성공 응답은 요청 id를 그대로 돌려준다', () => {
    // 미니앱이 여러 요청을 동시에 보내고 응답 순서가 다를 수 있다.
    expect(miniappOk('r7', { totalNet: 1000 })).toEqual({
      v: MINIAPP_BRIDGE_VERSION,
      kind: 'response',
      requestId: 'r7',
      ok: true,
      data: { totalNet: 1000 },
    });
  });

  it('오류 응답은 코드를 준다 — 미니앱이 분기할 수 있어야 한다', () => {
    const err = miniappError('r7', 'permission_denied', '권한이 없습니다');
    expect(err).toMatchObject({
      ok: false,
      requestId: 'r7',
      error: { code: 'permission_denied' },
    });
  });
});


describe('추가 계약 검증', () => {
  it('배열 params를 거부한다', () => {
    expect(isMiniappRequest({ ...req(), params: [] })).toBe(false);
  });
  it.each([null, {}, { ...miniappOk('r', null), v: 2 }, { ...miniappOk('r', null), data: undefined }, { v: 1, kind: 'response', requestId: 'r', ok: true }, { ...miniappError('r', 'host_error', '오류'), error: {} }])('불량 응답을 거부한다: %j', (value) => {
    expect(isMiniappResponse(value)).toBe(false);
  });
  it('정상 성공과 실패 응답을 구별한다', () => {
    expect(isMiniappResponse(miniappOk('r', null))).toBe(true);
    expect(isMiniappResponse(miniappError('r', 'host_error', '오류'))).toBe(true);
  });
});
