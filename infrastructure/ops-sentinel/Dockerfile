FROM node@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3

WORKDIR /app

COPY infrastructure/ops-sentinel/ops-sentinel.mjs /app/ops-sentinel.mjs
COPY infrastructure/ops-sentinel/ops-sentinel.verify.mjs /app/ops-sentinel.verify.mjs

RUN mkdir -p /state /monitored/backups \
  && chown -R node:node /app /state /monitored

USER node

ENTRYPOINT ["node", "/app/ops-sentinel.mjs"]
CMD ["daemon"]
