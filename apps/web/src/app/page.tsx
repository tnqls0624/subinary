"use client";

import {
  readyzResponseSchema,
  type HealthCheckItem,
  type ReadyzResponse,
} from "@family/contracts";
import { DEFAULT_TIMEZONE } from "@family/shared";
import { useQuery } from "@tanstack/react-query";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
const READY_PATH = "/v1/health/ready";
const POLL_INTERVAL_MS = 5_000;

/** 대시보드에 표시할 인프라 체크 항목(스펙 §9 검증 계약과 동일한 이름). */
const MONITORED_CHECKS: ReadonlyArray<{ name: string; label: string }> = [
  { name: "db", label: "DB" },
  { name: "pgvector", label: "pgvector" },
  { name: "redis", label: "Redis" },
  { name: "storage", label: "Storage" },
];

/** Asia/Seoul 기준 표시용 포맷터 (개인정보 없음, 순수 시각 표기). */
const seoulTimeFormatter = new Intl.DateTimeFormat("ko-KR", {
  timeZone: DEFAULT_TIMEZONE,
  hour12: false,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/**
 * `GET {API}/v1/health/ready`를 조회하고 @family/contracts 스키마로 파싱한다.
 * API는 정상 시 200(ok), 일부 의존성 다운 시 503(degraded)을 반환하지만
 * 두 경우 모두 readyz 계약을 따르는 JSON 본문을 담고 있으므로 상태코드와
 * 무관하게 본문을 파싱해 대시보드에 반영한다.
 */
async function fetchReadiness(): Promise<ReadyzResponse> {
  const res = await fetch(`${API_BASE_URL}${READY_PATH}`, {
    cache: "no-store",
    headers: { accept: "application/json" },
  });

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error(`API가 HTTP ${res.status} 상태로 JSON이 아닌 응답을 반환했습니다.`);
  }

  const parsed = readyzResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(
      `API 응답이 readyz 계약과 일치하지 않습니다 (HTTP ${res.status}).`,
    );
  }
  return parsed.data;
}

type OverallState = "loading" | "ok" | "degraded" | "unreachable";

const BANNER_TEXT: Record<OverallState, string> = {
  loading: "API 준비 상태를 확인하는 중…",
  ok: "모든 인프라가 정상입니다 (ok)",
  degraded: "일부 인프라가 비정상입니다 (degraded)",
  unreachable: "API에 연결할 수 없습니다",
};

function StatusBadge({
  status,
}: Readonly<{ status: "up" | "down" | "unknown" }>) {
  const label = status === "up" ? "UP" : status === "down" ? "DOWN" : "N/A";
  return <span className={`badge badge-${status}`}>{label}</span>;
}

function CheckCard({
  label,
  check,
  unreachable,
}: Readonly<{
  label: string;
  check: HealthCheckItem | undefined;
  unreachable: boolean;
}>) {
  const status: "up" | "down" | "unknown" =
    unreachable || check === undefined ? "unknown" : check.status;

  return (
    <div className="card">
      <h2 className="card-title">{label}</h2>
      <StatusBadge status={status} />
      {!unreachable && check?.latencyMs !== undefined ? (
        <p className="card-meta">latency: {check.latencyMs}ms</p>
      ) : null}
      {!unreachable && check?.detail ? (
        <p className="card-meta">{check.detail}</p>
      ) : null}
    </div>
  );
}

export default function DashboardPage() {
  const { data, error, isPending, dataUpdatedAt } = useQuery({
    queryKey: ["health", "ready"],
    queryFn: fetchReadiness,
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: true,
    retry: false,
  });

  const overall: OverallState = error
    ? "unreachable"
    : isPending
      ? "loading"
      : data?.status === "ok"
        ? "ok"
        : "degraded";

  const checksByName = new Map<string, HealthCheckItem>();
  for (const check of data?.checks ?? []) {
    checksByName.set(check.name, check);
  }

  const lastUpdatedLabel =
    dataUpdatedAt > 0 ? seoulTimeFormatter.format(new Date(dataUpdatedAt)) : null;

  return (
    <main className="page">
      <header className="header">
        <h1>Family Memory AI — Phase 0</h1>
        <p className="subtitle">
          인프라 준비 상태 대시보드 · {POLL_INTERVAL_MS / 1000}초 간격 폴링
        </p>
      </header>

      <p className="notice">
        실행 방법: <code>cp .env.example .env</code> 후{" "}
        <code>docker compose up --build</code>. 이 페이지는{" "}
        <code>
          {API_BASE_URL}
          {READY_PATH}
        </code>{" "}
        응답을 기준으로 서비스 상태를 표시합니다.
      </p>

      <div className={`banner banner-${overall}`} role="status">
        <span>{BANNER_TEXT[overall]}</span>
        {overall === "unreachable" && error instanceof Error ? (
          <span className="banner-detail">{error.message}</span>
        ) : null}
      </div>

      <section className="grid" aria-label="infrastructure checks">
        {MONITORED_CHECKS.map(({ name, label }) => (
          <CheckCard
            key={name}
            label={label}
            check={checksByName.get(name)}
            unreachable={overall === "unreachable"}
          />
        ))}
      </section>

      <footer className="footer">
        <p>
          service: <code>{data?.service ?? "api"}</code> · timezone:{" "}
          <code>{DEFAULT_TIMEZONE}</code>
        </p>
        {lastUpdatedLabel ? (
          <p>마지막 성공 수신: {lastUpdatedLabel} (Asia/Seoul)</p>
        ) : (
          <p>아직 성공한 응답이 없습니다.</p>
        )}
      </footer>
    </main>
  );
}
