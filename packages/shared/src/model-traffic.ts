import { createHash } from 'node:crypto';

/** 모델 traffic 정책의 실행 방식. */
export type ModelTrafficMode = 'shadow' | 'live';

/** 결정적 traffic 할당 결과. */
export interface ModelTrafficAssignment {
  /** 0 이상 10,000 미만의 결정적 버킷. */
  bucket: number;
  /** 이 요청에서 후보 모델을 실행할지 여부. */
  executeCandidate: boolean;
  /** 사용자 응답을 만들도록 선택된 모델 역할. */
  selectedRole: 'primary' | 'candidate';
}

/** {@link assignModelTraffic} 입력. */
export interface AssignModelTrafficInput {
  mode: ModelTrafficMode;
  trafficBasisPoints: number;
  routingKey: string;
  routingSalt: string;
}

/**
 * 원문 없는 routing key를 SHA-256으로 버킷화해 동일 정책/키를 항상 같은 모델에
 * 배정한다. `shadow`는 후보를 샘플링 실행하되 응답은 항상 primary가 선택된다.
 */
export function assignModelTraffic(
  input: AssignModelTrafficInput,
): ModelTrafficAssignment {
  if (!Number.isInteger(input.trafficBasisPoints)) {
    throw new TypeError('trafficBasisPoints must be an integer');
  }
  if (input.trafficBasisPoints < 1 || input.trafficBasisPoints > 10_000) {
    throw new RangeError('trafficBasisPoints must be between 1 and 10000');
  }
  if (input.routingKey.trim().length === 0) {
    throw new RangeError('routingKey must not be empty');
  }
  if (input.routingSalt.trim().length === 0) {
    throw new RangeError('routingSalt must not be empty');
  }

  const digest = createHash('sha256')
    .update(input.routingSalt, 'utf8')
    .update('\0', 'utf8')
    .update(input.routingKey, 'utf8')
    .digest();
  const bucket = digest.readUInt32BE(0) % 10_000;
  const executeCandidate = bucket < input.trafficBasisPoints;

  return {
    bucket,
    executeCandidate,
    selectedRole:
      input.mode === 'live' && executeCandidate ? 'candidate' : 'primary',
  };
}
