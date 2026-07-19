import pretty from 'pino-pretty';
import { describe, expect, it } from 'vitest';

import { PINO_PRETTY_TIME_FORMAT } from './logger.js';

describe('PINO_PRETTY_TIME_FORMAT', () => {
  it('dateformat 기준 월과 분을 올바른 위치에 출력한다', () => {
    const previousTimeZone = process.env.TZ;
    process.env.TZ = 'Asia/Seoul';

    try {
      const epoch = Date.parse('2026-07-18T14:37:35.732Z');
      const formatLog = pretty.prettyFactory({
        colorize: false,
        translateTime: PINO_PRETTY_TIME_FORMAT,
      });
      expect(formatLog({ level: 30, time: epoch, msg: '검증 로그' })).toContain(
        '[2026-07-18 23:37:35.732 +0900]',
      );
    } finally {
      if (previousTimeZone === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = previousTimeZone;
      }
    }
  });
});
