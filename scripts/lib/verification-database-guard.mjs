const POSTGRES_PROTOCOLS = new Set(['postgres:', 'postgresql:']);
const SAFE_DATABASE_NAME_PATTERN =
  /(?:^|[_-])(?:test|verify|verification)(?:[_-]|$)/iu;
const DISPOSABLE_DATABASE_NAME_PATTERN =
  /^family_memory_verify_[0-9]{14}_[a-f0-9]{8}$/u;

/**
 * PostgreSQL 연결 문자열에서 디코딩된 데이터베이스 이름을 추출한다.
 *
 * @param {string | undefined} databaseUrl PostgreSQL 연결 문자열
 * @returns {string} 데이터베이스 이름
 */
export function parseVerificationDatabaseName(databaseUrl) {
  if (typeof databaseUrl !== 'string' || databaseUrl.trim().length === 0) {
    throw new Error('DATABASE_URL이 필요합니다.');
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL이 올바른 URL 형식이 아닙니다.');
  }

  if (!POSTGRES_PROTOCOLS.has(parsedUrl.protocol)) {
    throw new Error('검증 DB는 PostgreSQL 연결 문자열이어야 합니다.');
  }

  let databaseName;
  try {
    databaseName = decodeURIComponent(parsedUrl.pathname.replace(/^\/+/, ''));
  } catch {
    throw new Error('DATABASE_URL의 데이터베이스 이름을 해석할 수 없습니다.');
  }

  if (databaseName.length === 0 || databaseName.includes('/')) {
    throw new Error('DATABASE_URL에 단일 데이터베이스 이름이 필요합니다.');
  }

  return databaseName;
}

/**
 * 쓰기형 모델 승격 검증이 독립 검증 DB에서만 실행되도록 차단한다.
 *
 * @param {{
 *   databaseUrl: string | undefined;
 *   allowWrite: string | undefined;
 *   nodeEnv: string | undefined;
 * }} input 실행 환경
 * @returns {{ databaseName: string }} 검증 대상 식별 정보
 */
export function assertVerificationDatabaseSafety(input) {
  if (input.allowWrite !== '1') {
    throw new Error('MODEL_GATE_VERIFY_ALLOW_WRITE=1이 필요합니다.');
  }

  if (input.nodeEnv?.trim().toLowerCase() === 'production') {
    throw new Error('NODE_ENV=production에서는 모델 승격 검증을 실행할 수 없습니다.');
  }

  const databaseName = parseVerificationDatabaseName(input.databaseUrl);
  if (!SAFE_DATABASE_NAME_PATTERN.test(databaseName)) {
    throw new Error(
      '검증 DB 이름에는 test, verify 또는 verification 구분자가 필요합니다.',
    );
  }

  return { databaseName };
}

/**
 * 자동 폐기 대상이 이번 실행에서 만든 고유 검증 DB 이름인지 확인한다.
 *
 * @param {string} databaseName 폐기할 데이터베이스 이름
 * @returns {string} 검증된 데이터베이스 이름
 */
export function assertDisposableVerificationDatabaseName(databaseName) {
  if (!DISPOSABLE_DATABASE_NAME_PATTERN.test(databaseName)) {
    throw new Error(
      '자동 폐기는 family_memory_verify_<timestamp>_<random> DB만 허용합니다.',
    );
  }

  return databaseName;
}

/**
 * 일회성 검증 DB를 생성하고 기존 PostgreSQL 초기화 SQL을 적용할 psql 입력을 만든다.
 *
 * @param {string} databaseName 생성할 일회성 데이터베이스 이름
 * @param {string} initializationSql 운영 DB와 공유하는 확장 초기화 SQL
 * @returns {string} psql 표준 입력
 */
export function buildDisposableVerificationDatabaseInitializationSql(
  databaseName,
  initializationSql,
) {
  const safeDatabaseName =
    assertDisposableVerificationDatabaseName(databaseName);
  if (
    typeof initializationSql !== 'string' ||
    initializationSql.trim().length === 0
  ) {
    throw new Error('검증 DB 초기화 SQL이 필요합니다.');
  }

  return [
    `CREATE DATABASE "${safeDatabaseName}";`,
    `\\connect ${safeDatabaseName}`,
    initializationSql.trim(),
    '',
  ].join('\n');
}
