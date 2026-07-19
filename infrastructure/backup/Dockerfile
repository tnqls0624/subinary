FROM minio/mc@sha256:a7fe349ef4bd8521fb8497f55c6042871b2ae640607cf99d9bede5e9bdf11727 AS minio-client

FROM pgvector/pgvector@sha256:d2ef61f42ef767baa5a1475393303cc235bcd92febd9d7014eddb48b41f3bad0

ARG TARGETARCH
ARG RESTIC_VERSION=0.19.1
ARG RESTIC_AMD64_SHA256=f415415624dcc452f2a02b8c33641791a8c6d6d3b65bbb3543fcf9a25151585c
ARG RESTIC_ARM64_SHA256=a5f64aaab53d51e311fa3829124c5b703f2d14cf187d8640b6be3b2b49376465

RUN set -eu; \
  case "$TARGETARCH" in \
    amd64) restic_sha256="$RESTIC_AMD64_SHA256" ;; \
    arm64) restic_sha256="$RESTIC_ARM64_SHA256" ;; \
    *) echo "unsupported restic architecture: $TARGETARCH" >&2; exit 64 ;; \
  esac; \
  apt-get update; \
  apt-get install -y --no-install-recommends bzip2 ca-certificates curl; \
  curl --fail --location --silent --show-error \
    "https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}/restic_${RESTIC_VERSION}_linux_${TARGETARCH}.bz2" \
    --output /tmp/restic.bz2; \
  echo "${restic_sha256}  /tmp/restic.bz2" | sha256sum --check --strict; \
  bunzip2 /tmp/restic.bz2; \
  install -m 0755 /tmp/restic /usr/local/bin/restic; \
  rm -rf /var/lib/apt/lists/* /tmp/restic

COPY --from=minio-client /usr/bin/mc /usr/local/bin/mc
COPY infrastructure/backup/backup-entrypoint.sh /usr/local/bin/backup-entrypoint.sh
COPY infrastructure/backup/backup-once.sh /usr/local/bin/backup-once.sh
COPY infrastructure/backup/backup-healthcheck.sh /usr/local/bin/backup-healthcheck.sh
COPY infrastructure/backup/verify-backup.sh /usr/local/bin/verify-backup.sh
COPY infrastructure/backup/backup-replica.sh /usr/local/bin/backup-replica.sh
COPY infrastructure/backup/backup-replica-healthcheck.sh /usr/local/bin/backup-replica-healthcheck.sh

RUN chmod 0755 \
  /usr/local/bin/backup-entrypoint.sh \
  /usr/local/bin/backup-once.sh \
  /usr/local/bin/backup-healthcheck.sh \
  /usr/local/bin/verify-backup.sh \
  /usr/local/bin/backup-replica.sh \
  /usr/local/bin/backup-replica-healthcheck.sh

ENTRYPOINT ["/usr/local/bin/backup-entrypoint.sh"]
CMD ["daemon"]
