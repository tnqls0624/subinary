# Sandbox 엔진 실행 검증

이 폴더는 임시 검증물이다. 앱 의존성이나 기존 앱 코드를 변경하지 않는다.

저장소 루트에서 실행한다.

```sh
python3 -m http.server 8765 --bind 127.0.0.1 --directory scripts/verify-sandbox-engine
```

실제 브라우저에서 `http://127.0.0.1:8765/index.html`을 연다. 두 iframe은 `sandbox="allow-scripts"`만 사용한다. 기본 Python 정적 서버는 CORS 허용 헤더를 추가하지 않는다. 파일 프로토콜로 열면 이 시험과 조건이 다르다.

부모 페이지는 `event.source`로 iframe을 식별하고 `VERIFY` 메시지 및 발신 origin을 콘솔과 화면에 누적한다. `ping → ack → roundtrip`은 revision 7 왕복이다. 엔진 씬 생성/시작 완료, 외부 PNG 및 JSON, 인라인 PNG, Phaser 생성 텍스처, 60회 업데이트를 따로 기록한다. Phaser 캔버스를 클릭하면 입력 이벤트 종류와 `isTrusted`, `wasTouch`를 기록한다. 결과가 없으면 통과가 아니다.

초록색 PNG는 이 검증을 위해 생성한 32×32 이미지다. Phaser 화면에서 외부 이미지 위치는 (80,100), 인라인 이미지는 (180,100), 생성 텍스처는 (280,100)이다. Excalibur의 노란 사각형은 Actor 도형이다.

버전 고정 배포물:

- Phaser 4.2.1: https://cdn.jsdelivr.net/npm/phaser@4.2.1/dist/phaser.min.js
- Excalibur 0.32.0: https://cdn.jsdelivr.net/npm/excalibur@0.32.0/build/dist/excalibur.min.js

미니파이 배포물은 저장소에 두지 않는다(약 1.9MB). 재현할 때 위 고정 URL로 내려받는다.

```sh
curl -sSLo scripts/verify-sandbox-engine/vendor/phaser.min.js \
  https://cdn.jsdelivr.net/npm/phaser@4.2.1/dist/phaser.min.js
curl -sSLo scripts/verify-sandbox-engine/vendor/excalibur.min.js \
  https://cdn.jsdelivr.net/npm/excalibur@0.32.0/build/dist/excalibur.min.js
```

라이선스는 `vendor/PHASER-LICENSE.md`, `vendor/EXCALIBUR-LICENSE.md`에 보존했다. 브리지는 검증용이며 제품 저장 프로토콜 전체를 구현하지 않는다.
