# 관측 UI 접근 + Beszel 메트릭 온보딩

관측 UI는 **`127.0.0.1`(맥 로컬 loopback)에만 포트를 바인딩**한다 — LAN·인터넷에 노출되지 않아
"인바운드 0(라우터/인터넷 노출 없음)" 기조와 어긋나지 않는다. 맥에서 브라우저로 바로 접근:

| UI | 로컬 주소 | 비고 |
|---|---|---|
| Gatus(상태) | http://localhost:8080 | 상시 실행 |
| Dozzle(로그) | http://localhost:8081 | 상시 실행. 앱 컨테이너는 도달 불가(격리 유지) |
| Beszel(메트릭) | http://localhost:8090 | profile 게이트 — 먼저 기동 필요(§A) |

원격(맥 밖)에서 봐야 하거나 상시 도메인 접근이 필요하면 (B) caddy + Cloudflare Access로 노출한다.
이 문서는 (A) Beszel 메트릭 온보딩과 (B) 원격 UI 노출 절차를 다룬다.

> ℹ️ 포트는 `docker-compose.prod.yml`에 `127.0.0.1:PORT:PORT`로 선언돼 상시 유지된다(socat 등 임시 포워딩 불필요).
> ⚠️ (B)는 caddy 재생성(배포)을 수반한다. 다른 세션이 스택을 배포 중이면 끝난 뒤 진행한다.

---

## A. Beszel 메트릭 온보딩

Beszel은 hub(대시보드, 컨테이너)와 agent(수집기)로 나뉜다. **핵심: agent는 맥 네이티브(prebuilt 바이너리 또는
brew)로 설치**해야 Docker Desktop의 Linux VM이 아니라 진짜 맥 호스트(CPU/메모리/디스크/온도)를 측정한다.
hub는 프로필 게이트라 평시 `compose up -d`에는 뜨지 않는다.

### 1) hub 기동
```sh
docker compose --env-file .env --env-file .env.production -f docker-compose.prod.yml \
  --profile observability up -d beszel
```
데이터는 `beszel-data` 볼륨(`/beszel_data`)에 저장. 기동되면 hub UI는 `127.0.0.1:8090`에 바인딩되어
맥에서 http://localhost:8090 으로 바로 접근된다(compose에 포트 선언됨). 상시 도메인 접근은 §B.

### 2) 관리자 계정 생성
첫 접속 시 UI가 admin 계정 생성을 요구한다. 가족 이메일로 생성.

### 3) 맥 네이티브 agent 설치
agent는 반드시 맥 네이티브로 설치한다(컨테이너는 VM만 측정). 설치 방법 두 가지:

**(a) prebuilt 바이너리 — 권장(Command Line Tools 상관없음)**
```sh
curl -fsSL -o /tmp/ba.tgz \
  https://github.com/henrygd/beszel/releases/download/v0.18.7/beszel-agent_darwin_arm64.tar.gz
tar xzf /tmp/ba.tgz -C /tmp && install -m 0755 /tmp/beszel-agent ~/.local/bin/beszel-agent
```
**(b) brew** — Xcode Command Line Tools가 최신일 때만(구버전이면 소스 빌드 실패):
```sh
brew install henrygd/beszel/beszel-agent   # 실패 시 (a)로. sudo xcode-select --install 후 재시도 가능.
```

### 4) hub에 시스템 등록 + agent 연결 (토큰/WebSocket 방식)
Beszel v0.18은 **토큰(WebSocket)** 방식이 기본이자 이 구성(hub=컨테이너, agent=native)에 가장 간단하다
— agent가 hub로 나가 붙으므로 hub가 맥으로 되돌아오는 연결이 불필요하다.

1. hub UI **Add System**: Name(예 `mac-homeserver`) 입력. Host/IP·Port는 토큰 방식이면 실제로 안 쓰이지만
   UI가 요구하면 `host.docker.internal` / `45876`을 넣어도 무방. 저장하면 **토큰(UUID)**이 나온다 → 복사.
2. agent는 토큰 외에 **hub의 SSH 공개키**도 필요하다. 공개키는 hub 데이터 볼륨의 개인키에서 유도한다:
   ```sh
   docker run --rm -v family-memory-ai_beszel-data:/d alpine:latest sh -c \
     'apk add -q openssh-keygen 2>/dev/null; ssh-keygen -y -f /d/id_ed25519'
   # → ssh-ed25519 AAAA... (이 값이 --key)
   ```
3. LaunchAgent로 등록(재부팅에도 자동 시작). `~/Library/LaunchAgents/ai.subinary.beszel-agent.plist`:
   ProgramArguments = `~/.local/bin/beszel-agent --key "<위 공개키>" --token <UUID> --url http://localhost:8090`,
   `RunAtLoad`/`KeepAlive` true, 로그 `~/Library/Logs/beszel-agent.log`, 권한 600(토큰 포함).
   ```sh
   launchctl load -w ~/Library/LaunchAgents/ai.subinary.beszel-agent.plist
   beszel-agent health   # → ok
   ```
   로그에 `WebSocket connected host=localhost:8090`이 뜨고, hub UI에서 시스템이 초록색이면 성공.
   중지·제거: `launchctl unload ~/Library/LaunchAgents/ai.subinary.beszel-agent.plist`.

> 대안(SSH 방식): Add System에서 SSH 공개키(KEY)가 나오면 agent를 `--key "<KEY>" --listen 45876`로 띄우고
> Host/IP=`host.docker.internal`, Port=`45876`로 등록한다(hub→agent 역방향, compose의 `extra_hosts`가 이를 지원).

### 5) 경보(선택)
ops-sentinel이 이미 디스크를 감시하므로 **중복을 피해 CPU/메모리 임계만** Beszel 경보로 설정한다.
알림 채널은 기존 webhook(generic/Slack) 또는 ntfy. Beszel은 Shoutrrr 기반 다수 채널을 지원한다.

---

## B. 관측 UI 노출 (caddy 서브도메인 + Cloudflare Access)

세 UI를 서브도메인으로 노출하되 **Cloudflare Access(이메일 인증) 뒤**에만 둔다. 인바운드 포트는 늘지 않는다
(전부 기존 cloudflared 터널 경유).

### 1) Caddyfile.prod에 서브도메인 블록 추가
기존 `:80` 블록은 그대로 두고 host-매칭 사이트를 추가한다(Caddy는 host 명시 사이트를 `:80` 캐치올보다 우선 매칭):
```caddy
# 기존 :80 { ... } 블록 유지

http://status.subinary.cloud  { reverse_proxy gatus:8080 }
http://metrics.subinary.cloud { reverse_proxy beszel:8090 }
# dozzle은 socket-proxy(internal) + observability 망에 있고 default엔 없다(앱 컨테이너 도달 차단).
# caddy로 로그 UI를 노출하려면 caddy를 observability 망에 추가로 붙이고(dozzle을 default에 넣지 말 것),
# DOZZLE_AUTH로 2차 인증을 건 뒤에만 열 것. 로컬 접근만이면 http://localhost:8081 로 충분(노출 불필요).
# http://logs.subinary.cloud  { reverse_proxy dozzle:8080 }
```
gatus·beszel은 default 망이라 caddy가 바로 닿는다. **적용은 caddy 재생성**:
```sh
docker compose ... up -d caddy
```

### 2) Cloudflare Zero Trust — Public Hostname 추가
터널 설정(Networks → Tunnels → 해당 터널 → Public Hostname)에 각 서브도메인을 `http://caddy:80`으로 매핑.
(앱 `app.subinary.cloud`와 동일 방식.)

### 3) Cloudflare Access 애플리케이션 생성 (필수)
각 서브도메인마다 Access 애플리케이션을 만들고 **가족 이메일 allowlist** 정책을 건다.
Access 없이 노출하면 인터넷에 관측 UI가 공개되므로 반드시 선행한다.

### 4) 심층 방어(Dozzle 노출 시)
Dozzle을 노출하기로 하면 CF Access만 믿지 말고 `DOZZLE_AUTH_PROVIDER`로 2차 인증(예: forward-proxy로
`Cf-Access-Authenticated-User-Email` 헤더 검증)을 건다. Dozzle은 socket-proxy 경유로 전 컨테이너 로그를
읽으므로 노출 표면이 가장 크다.

---

## 요약: 무엇이 어디서 도는가
| 컴포넌트 | 위치 | 호스트 실측 | 로컬 UI | 원격 노출 |
|---|---|---|---|---|
| Beszel hub | 컨테이너(profile observability) | ✗(VM) | localhost:8090 | caddy+Access |
| Beszel agent | **맥 네이티브(brew)** | ✓ 진짜 맥 | — | — |
| Gatus | 컨테이너(default) | ✗ | localhost:8080 | caddy+Access |
| Dozzle | 컨테이너(socket-proxy+observability) | ✗ | localhost:8081 | caddy+observability+DOZZLE_AUTH |
| ops-sentinel | 컨테이너 | 디스크/백업만 | — | — |

로컬 UI 포트는 전부 `127.0.0.1` 바인딩(LAN·인터넷 비노출). 앱 컨테이너는 dozzle에 도달 불가(격리 유지).
