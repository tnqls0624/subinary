import { describe, expect, it } from 'vitest';

import { assignModelTraffic } from './model-traffic.js';

describe('assignModelTraffic', () => {
  it('동일 salt와 routing key를 항상 동일 버킷에 할당한다', () => {
    const input = {
      mode: 'live' as const,
      trafficBasisPoints: 5_000,
      routingKey: 'sha256-routing-key',
      routingSalt: 'policy-salt',
    };

    expect(assignModelTraffic(input)).toEqual(assignModelTraffic(input));
  });

  it('shadow는 후보를 실행해도 primary 응답을 선택한다', () => {
    const assigned = assignModelTraffic({
      mode: 'shadow',
      trafficBasisPoints: 10_000,
      routingKey: 'request',
      routingSalt: 'policy',
    });

    expect(assigned.executeCandidate).toBe(true);
    expect(assigned.selectedRole).toBe('primary');
  });

  it('live 100%는 candidate 응답을 선택한다', () => {
    const assigned = assignModelTraffic({
      mode: 'live',
      trafficBasisPoints: 10_000,
      routingKey: 'request',
      routingSalt: 'policy',
    });

    expect(assigned.selectedRole).toBe('candidate');
  });

  it('잘못된 basis point와 빈 key를 거부한다', () => {
    expect(() =>
      assignModelTraffic({
        mode: 'live',
        trafficBasisPoints: 0,
        routingKey: 'request',
        routingSalt: 'policy',
      }),
    ).toThrow(RangeError);
    expect(() =>
      assignModelTraffic({
        mode: 'live',
        trafficBasisPoints: 100,
        routingKey: ' ',
        routingSalt: 'policy',
      }),
    ).toThrow(RangeError);
  });
});
