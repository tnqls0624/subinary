"use client";
/* ---------------------------------------------------------------------------
 * Family Memory AI — web · 장치 관리 (Phase 5 §6.2 P8)
 *
 * - 장치 목록: 이름 / 플랫폼 / 마지막 수신(lastSeenAt) / 상태.
 * - 등록 폼: 이름 + 플랫폼 → secret 1회 모달(서명 레시피 안내 포함).
 * - 회전(rotate-secret): secret 재발급 후 동일 모달로 재표시.
 * - 폐기(revoke): HMAC 인증 차단.
 * secret은 register/rotate 응답에서 단 한 번만 노출되며 이후 다시 볼 수 없다.
 * ------------------------------------------------------------------------- */
import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import type {
  DevicePlatform,
  DeviceRegisterRequest,
  DeviceSecretResponse,
  DeviceSummary,
} from "@family/contracts";

import {
  Button,
  Field,
  Modal,
  Select,
  StatusBadge,
  Table,
  type SelectOption,
  type TableColumn,
} from "@/components";
import { ApiError, api } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { useHousehold } from "@/lib/household-context";
import { useDevices } from "@/lib/queries";
import { formatDate } from "@/lib/format";

/** 플랫폼 표시 라벨. */
const PLATFORM_LABEL: Record<DevicePlatform, string> = {
  ios: "iOS",
  android: "Android",
  other: "기타",
};

const PLATFORM_OPTIONS: ReadonlyArray<SelectOption> = (
  ["ios", "android", "other"] as const
).map((value) => ({ value, label: PLATFORM_LABEL[value] }));

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

export default function DevicesPage() {
  const { authedFetch } = useAuth();
  const { householdId } = useHousehold();
  const queryClient = useQueryClient();

  const devicesQuery = useDevices();

  const [name, setName] = useState("");
  const [platform, setPlatform] = useState<DevicePlatform>("ios");
  const [formError, setFormError] = useState<string | null>(null);

  // register/rotate 공용: secret 1회 노출 모달.
  const [secret, setSecret] = useState<DeviceSecretResponse | null>(null);
  const [copied, setCopied] = useState(false);

  const invalidateDevices = () =>
    queryClient.invalidateQueries({ queryKey: ["devices", householdId] });

  const registerMutation = useMutation({
    mutationFn: (body: DeviceRegisterRequest) =>
      authedFetch((token) => api.devices.register(token, body)),
    onSuccess: (result) => {
      void invalidateDevices();
      setName("");
      setPlatform("ios");
      setFormError(null);
      setCopied(false);
      setSecret(result);
    },
  });

  const rotateMutation = useMutation({
    mutationFn: (id: string) =>
      authedFetch((token) => api.devices.rotate(token, id)),
    onSuccess: (result) => {
      void invalidateDevices();
      setCopied(false);
      setSecret(result);
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) =>
      authedFetch((token) => api.devices.revoke(token, id)),
    onSuccess: () => void invalidateDevices(),
  });

  function onRegister(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    if (!householdId) return;
    if (name.trim() === "") {
      setFormError("장치 이름을 입력하세요.");
      return;
    }
    registerMutation.mutate({
      householdId,
      name: name.trim(),
      platform,
    });
  }

  function onRotate(device: DeviceSummary) {
    if (
      !window.confirm(
        `'${device.name}' 장치의 secret을 재발급할까요? 이전 secret은 즉시 무효화됩니다.`,
      )
    )
      return;
    rotateMutation.mutate(device.id);
  }

  function onRevoke(device: DeviceSummary) {
    if (
      !window.confirm(
        `'${device.name}' 장치를 폐기할까요? 이후 해당 장치의 문자 수신이 차단됩니다.`,
      )
    )
      return;
    revokeMutation.mutate(device.id);
  }

  async function copySecret() {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret.secret);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const devices = devicesQuery.data ?? [];

  const columns: ReadonlyArray<TableColumn<DeviceSummary>> = [
    {
      key: "name",
      header: "이름",
      render: (d) => d.name,
    },
    {
      key: "platform",
      header: "플랫폼",
      render: (d) => PLATFORM_LABEL[d.platform],
    },
    {
      key: "lastSeenAt",
      header: "마지막 수신",
      render: (d) =>
        d.lastSeenAt ? (
          formatDate(d.lastSeenAt)
        ) : (
          <span className="text-subtle">수신 없음</span>
        ),
    },
    {
      key: "status",
      header: "상태",
      render: (d) => <StatusBadge status={d.status} />,
    },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (d) =>
        d.status === "active" ? (
          <span className="row" style={{ justifyContent: "flex-end", gap: 6 }}>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => onRotate(d)}
              disabled={rotateMutation.isPending}
            >
              secret 재발급
            </button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={() => onRevoke(d)}
              disabled={revokeMutation.isPending}
            >
              폐기
            </button>
          </span>
        ) : (
          <span className="text-subtle">—</span>
        ),
    },
  ];

  return (
    <div className="stack">
      <h1 className="section-title">장치</h1>

      {/* 목록 ------------------------------------------------------------- */}
      <section className="panel">
        <div className="panel-title">등록된 장치</div>
        {devicesQuery.isLoading ? (
          <p className="empty">불러오는 중…</p>
        ) : devicesQuery.isError ? (
          <p className="form-error" role="alert">
            {errorMessage(devicesQuery.error, "장치를 불러오지 못했습니다.")}
          </p>
        ) : (
          <Table
            columns={columns}
            rows={devices}
            rowKey={(d) => d.id}
            emptyLabel="등록된 장치가 없습니다"
          />
        )}
        {revokeMutation.isError ? (
          <p className="form-error" role="alert" style={{ marginTop: 12 }}>
            {errorMessage(revokeMutation.error, "폐기에 실패했습니다.")}
          </p>
        ) : null}
        {rotateMutation.isError ? (
          <p className="form-error" role="alert" style={{ marginTop: 12 }}>
            {errorMessage(rotateMutation.error, "secret 재발급에 실패했습니다.")}
          </p>
        ) : null}
      </section>

      {/* 등록 폼 ---------------------------------------------------------- */}
      <section className="panel">
        <div className="panel-title">장치 등록</div>
        <form className="stack" onSubmit={onRegister} noValidate>
          <div className="row" style={{ alignItems: "flex-end", gap: 12 }}>
            <Field
              label="장치 이름"
              name="device-name"
              type="text"
              placeholder="예: 엄마 아이폰"
              maxLength={100}
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <label className="field">
              <span className="field-label">플랫폼</span>
              <Select
                options={PLATFORM_OPTIONS}
                value={platform}
                onChange={(e) => setPlatform(e.target.value as DevicePlatform)}
              />
            </label>
          </div>
          {formError ? (
            <p className="form-error" role="alert">
              {formError}
            </p>
          ) : null}
          {registerMutation.isError ? (
            <p className="form-error" role="alert">
              {errorMessage(registerMutation.error, "장치 등록에 실패했습니다.")}
            </p>
          ) : null}
          <div>
            <Button
              type="submit"
              variant="primary"
              disabled={registerMutation.isPending}
            >
              {registerMutation.isPending ? "등록 중…" : "장치 등록"}
            </Button>
          </div>
        </form>
      </section>

      {/* secret 1회 노출 모달 --------------------------------------------- */}
      <Modal
        open={secret !== null}
        title="장치 secret (1회만 표시)"
        onClose={() => setSecret(null)}
        footer={
          <Button variant="primary" onClick={() => setSecret(null)}>
            확인
          </Button>
        }
      >
        {secret ? (
          <div className="stack">
            <p className="form-error" role="alert" style={{ margin: 0 }}>
              이 secret은 지금만 확인할 수 있습니다. 장치 앱에 안전하게 저장하세요.
            </p>
            <div>
              <span className="field-label">장치</span>
              <p style={{ margin: "4px 0 0" }}>{secret.device.name}</p>
            </div>
            <div>
              <span className="field-label">deviceId</span>
              <p style={{ margin: "4px 0 0" }}>
                <code>{secret.deviceId}</code>
              </p>
            </div>
            <div>
              <span className="field-label">secret</span>
              <p style={{ margin: "4px 0 0", wordBreak: "break-all" }}>
                <code>{secret.secret}</code>
              </p>
              <div style={{ marginTop: 8 }}>
                <Button size="sm" variant="secondary" onClick={copySecret}>
                  {copied ? "복사됨" : "secret 복사"}
                </Button>
              </div>
            </div>
            <div>
              <span className="field-label">서명 방식</span>
              <p style={{ margin: "4px 0 0" }} className="text-muted">
                {secret.algorithm}
              </p>
              <p
                style={{ margin: "4px 0 0", whiteSpace: "pre-wrap" }}
                className="text-muted"
              >
                {secret.signingRecipe}
              </p>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
