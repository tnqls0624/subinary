#!/usr/bin/env node
// =============================================================================
// money-fence.mjs — 금액 계약 전환 운영 도구 (ADR-0027 롤아웃 5단계)
// -----------------------------------------------------------------------------
// 쓰기 펜스와 승격 일시정지를 **재시작 없이** 켜고 끄고, 두 서비스의 모드를 한 번에
// 읽는다. 이 스크립트는 스위치를 조작할 뿐 **금액을 한 푼도 계산하지 않는다.**
//
// ## 왜 HTTP 엔드포인트가 아니라 스크립트인가
//
// 이 API는 Cloudflare Tunnel로 인터넷 전체에 열려 있다. "금액 처리를 전부 멈추는"
// 엔드포인트를 그 표면에 새로 다는 것은, 아무리 인증을 걸어도 **없어도 되는 위험**이다.
// 전환을 수행하는 사람은 이미 호스트 셸에서 `docker compose`를 돌린다 — 그 사람에게
// 필요한 것은 셸 명령이지 HTTP 라우트가 아니다. 그래서 새 인증 경계를 만들지 않았다.
//
// ## 어떻게 동작하나
//
// 상태는 Redis 키 세 종류다(`@family/shared`의 `money-runtime.ts`가 이름을 소유).
//   <prefix>:money:write-fence       존재 = API 4개 쓰기 경로가 503
//   <prefix>:money:promotion-pause   존재 = worker 승격 소비 정지(큐 + 스케줄러 둘 다)
//   <prefix>:money:mode:{api,worker} 각 서비스가 게시한 현재 모드(TTL 60초)
//
// 조작은 `docker compose exec redis redis-cli`로 한다 — 이 저장소 루트에는 ioredis가
// 없고(pnpm workspace), redis 컨테이너에는 redis-cli가 항상 있다. 노드 의존성 0.
//
// ## ⚠️ 프로젝트 이름을 반드시 지정한다
//
// `-p`를 빠뜨리면 운영 스택(`family-memory-ai`)을 건드린다. 그래서 이 스크립트는
// **`--project`를 필수로 요구하고**, 운영 프로젝트일 때는 `--i-know`를 한 번 더 받는다.
//
// 실행:
//   node scripts/money-fence.mjs status  --project fma-verify
//   node scripts/money-fence.mjs on      --project fma-verify [--ttl 900]
//   node scripts/money-fence.mjs off     --project fma-verify
//   node scripts/money-fence.mjs pause   --project fma-verify [--ttl 900]
//   node scripts/money-fence.mjs resume  --project fma-verify
//
// 종료 코드:
//   0 = 성공 (status는 "전환을 진행해도 되는 상태"일 때만 0)
//   1 = status 판정이 진행 불가 (모드 불일치·미게시 등)
//   2 = 사용법 오류
//   3 = 실행 실패(컨테이너 부재·redis 응답 없음 등)
// =============================================================================
import { execFileSync } from 'node:child_process';

/** 운영 스택 프로젝트명. 여기에 조작을 걸려면 `--i-know`가 필요하다. */
const PRODUCTION_PROJECT = 'family-memory-ai';

/** `@family/shared`의 상수와 같은 값이어야 한다(그쪽이 단일 출처, 여기는 사본). */
const DEFAULT_TTL_SEC = 900;
const MAX_TTL_SEC = 3_600;

const USAGE = `사용법:
  node scripts/money-fence.mjs <status|on|off|pause|resume> --project <compose 프로젝트명> [--ttl <초>]

  status  현재 펜스·정지·두 서비스 모드를 보고 "전환 진행 가능"을 판정한다
  on      쓰기 펜스 ON  (TTL 자동 만료)
  off     쓰기 펜스 OFF
  pause   worker 승격 소비 정지 (TTL 자동 만료)
  resume  worker 승격 소비 재개

  --project 는 필수다. 운영(${PRODUCTION_PROJECT})에는 --i-know 를 함께 줘야 한다.`;

function fail(code, message) {
  console.error(message);
  process.exit(code);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command, project: null, ttl: DEFAULT_TTL_SEC, iKnow: false };
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === '--project') {
      options.project = rest[i + 1];
      i += 1;
    } else if (token === '--ttl') {
      options.ttl = Number(rest[i + 1]);
      i += 1;
    } else if (token === '--i-know') {
      options.iKnow = true;
    } else {
      fail(2, `알 수 없는 인자: ${token}\n\n${USAGE}`);
    }
  }
  return options;
}

/** compose 프로젝트 안에서 redis-cli를 실행한다. 출력은 trim된 문자열. */
function redis(project, args) {
  try {
    return execFileSync(
      'docker',
      ['compose', '-p', project, 'exec', '-T', 'redis', 'redis-cli', ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  } catch (error) {
    fail(
      3,
      `redis 명령 실패 (project=${project}): ${error?.message ?? 'unknown'}\n` +
        'compose 프로젝트가 떠 있는지, redis 서비스 이름이 맞는지 확인하세요.',
    );
  }
}

/**
 * BullMQ prefix를 컨테이너 환경에서 읽는다.
 *
 * 하드코딩하지 않는 이유: 키 접두가 `BULLMQ_PREFIX`에서 나오는데 스택마다 다를 수 있고,
 * 틀린 접두로 키를 쓰면 **아무 일도 일어나지 않으면서 성공한 것처럼 보인다** — 전환
 * 중에 가장 위험한 실패 모양이다.
 */
function queuePrefix(project) {
  try {
    const raw = execFileSync(
      'docker',
      [
        'compose', '-p', project, 'exec', '-T', 'api',
        'node', '-e', 'process.stdout.write(process.env.BULLMQ_PREFIX ?? "")',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    if (raw === '') {
      fail(3, 'api 컨테이너에 BULLMQ_PREFIX가 비어 있습니다 — 키 접두를 알 수 없어 중단합니다.');
    }
    return raw;
  } catch (error) {
    fail(3, `BULLMQ_PREFIX 조회 실패: ${error?.message ?? 'unknown'}`);
  }
}

const keys = (prefix) => ({
  fence: `${prefix}:money:write-fence`,
  pause: `${prefix}:money:promotion-pause`,
  apiMode: `${prefix}:money:mode:api`,
  workerMode: `${prefix}:money:mode:worker`,
});

function readState(project, k) {
  const ttlOf = (key) => Number(redis(project, ['TTL', key]));
  const getOf = (key) => {
    const value = redis(project, ['GET', key]);
    return value === '' ? null : value;
  };
  return {
    fenceOn: redis(project, ['EXISTS', k.fence]) === '1',
    fenceTtl: ttlOf(k.fence),
    pauseOn: redis(project, ['EXISTS', k.pause]) === '1',
    pauseTtl: ttlOf(k.pause),
    apiMode: getOf(k.apiMode),
    workerMode: getOf(k.workerMode),
  };
}

function printStatus(state) {
  const line = (label, value) => console.log(`  ${label.padEnd(22)} ${value}`);
  console.log('\n금액 계약 전환 상태\n');
  line('쓰기 펜스', state.fenceOn ? `ON (남은 ${state.fenceTtl}초)` : 'off');
  line('승격 소비', state.pauseOn ? `PAUSED (남은 ${state.pauseTtl}초)` : 'running');
  line('API 모드', state.apiMode ?? '(게시 없음)');
  line('worker 모드', state.workerMode ?? '(게시 없음)');

  // 불일치 판정은 `@family/shared`의 verifyMoneyModeAgreement와 같은 규칙이다.
  // "모르는 것"을 "일치"로 접지 않는다 — 한쪽이 응답하지 않으면 그 서비스가 어떤 계약으로
  // 쓰는지 모르는 것이고, ADR이 금지한 상태를 배제할 수 없다.
  let verdict;
  if (state.apiMode === null || state.workerMode === null) {
    verdict = {
      ok: false,
      text: '두 서비스 중 하나가 모드를 게시하지 않았어요 (미기동이거나 Redis 연결 실패)',
    };
  } else if (state.apiMode !== state.workerMode) {
    verdict = {
      ok: false,
      text: `모드가 갈렸어요 — API=${state.apiMode} · worker=${state.workerMode}. 사용자 쓰기를 재개하면 안 됩니다`,
    };
  } else {
    verdict = { ok: true, text: `두 서비스 모두 ${state.apiMode}` };
  }
  console.log(`\n  판정: ${verdict.ok ? '✅' : '⛔'} ${verdict.text}\n`);
  return verdict.ok;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.command || options.command === '--help' || options.command === '-h') {
    console.log(USAGE);
    process.exit(2);
  }
  if (!options.project) {
    fail(2, `--project 는 필수입니다 (빠뜨리면 운영 스택을 건드립니다).\n\n${USAGE}`);
  }
  if (options.project === PRODUCTION_PROJECT && !options.iKnow) {
    fail(
      2,
      `운영 스택(${PRODUCTION_PROJECT})입니다. 정말 조작하려면 --i-know 를 붙이세요.`,
    );
  }
  if (!Number.isInteger(options.ttl) || options.ttl < 30 || options.ttl > MAX_TTL_SEC) {
    fail(2, `--ttl 은 30~${MAX_TTL_SEC} 사이 정수여야 합니다 (받은 값: ${options.ttl}).`);
  }

  const prefix = queuePrefix(options.project);
  const k = keys(prefix);

  switch (options.command) {
    case 'status': {
      const agreed = printStatus(readState(options.project, k));
      process.exit(agreed ? 0 : 1);
      break;
    }
    case 'on': {
      // TTL을 **켤 때 함께** 지정한다. "끄는 것을 잊어도 풀린다"가 이 설계의 핵심이다.
      redis(options.project, ['SET', k.fence, String(Date.now()), 'EX', String(options.ttl)]);
      console.log(`쓰기 펜스 ON — ${options.ttl}초 뒤 자동 해제됩니다.`);
      printStatus(readState(options.project, k));
      break;
    }
    case 'off': {
      redis(options.project, ['DEL', k.fence]);
      console.log('쓰기 펜스 OFF.');
      printStatus(readState(options.project, k));
      break;
    }
    case 'pause': {
      redis(options.project, ['SET', k.pause, String(Date.now()), 'EX', String(options.ttl)]);
      console.log(
        `승격 소비 PAUSE — ${options.ttl}초 뒤 자동 재개됩니다.\n` +
          '  (worker가 최대 2초 안에 반영합니다. 큐의 잡은 사라지지 않고 쌓입니다.)',
      );
      printStatus(readState(options.project, k));
      break;
    }
    case 'resume': {
      redis(options.project, ['DEL', k.pause]);
      console.log('승격 소비 RESUME (worker가 최대 2초 안에 반영합니다).');
      printStatus(readState(options.project, k));
      break;
    }
    default:
      fail(2, `알 수 없는 명령: ${options.command}\n\n${USAGE}`);
  }
}

main();
