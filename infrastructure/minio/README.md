# MinIO (Object Storage)

Phase 0의 개발용 Object Storage. **S3 호환 API**를 제공하므로 앱은
`@aws-sdk/client-s3` 하나로 dev(MinIO)/prod(S3 등)를 동일하게 사용한다.

## 구성 (docker-compose.yml이 전부 담당)

이 디렉터리에는 별도 설정 파일이 없다. 구성은 `docker-compose.yml`의 두 서비스로 이뤄진다.

| 서비스 | 역할 |
|---|---|
| `minio` | `minio/minio:latest`, `server /data --console-address ":9001"` 로 기동 |
| `minio-setup` | `minio/mc` 일회성 컨테이너. MinIO가 응답할 때까지 alias 등록을 재시도한 뒤 `mc mb --ignore-existing local/$STORAGE_BUCKET` 로 버킷을 생성하고 종료 |

`api`/`worker` 서비스는 `minio-setup`의 `service_completed_successfully` 조건에 의존하므로,
앱이 부팅되는 시점에는 버킷(`family-memory`)이 항상 존재한다.

## 자격증명 매핑

루트 `.env`의 스토리지 변수가 MinIO 컨테이너 자격증명으로 매핑된다.

| .env 변수 | MinIO 환경변수 |
|---|---|
| `STORAGE_ACCESS_KEY` | `MINIO_ROOT_USER` |
| `STORAGE_SECRET_KEY` | `MINIO_ROOT_PASSWORD` |

앱 쪽 접속 설정은 `STORAGE_ENDPOINT` / `STORAGE_REGION` / `STORAGE_BUCKET` /
`STORAGE_FORCE_PATH_STYLE=true` (path-style은 MinIO 필수)를 사용한다.

## 포트

| 용도 | 포트 |
|---|---|
| S3 API | 9000 |
| Web Console | 9001 (http://localhost:9001, `.env`의 자격증명으로 로그인) |

## 검증

```bash
# api를 통한 put→get 왕복 테스트
curl -X POST http://localhost:3001/v1/dev/storage-test
# → { "ok": true, "bucket": "family-memory", "key": "...", "roundTripMs": ... }
```

> 주의: `.env`의 dev 자격증명은 로컬 전용이다. 운영 환경에서는 절대 재사용하지 않는다.
