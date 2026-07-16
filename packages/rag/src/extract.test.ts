import { describe, expect, it } from 'vitest';

import {
  extractMemoryCandidates,
  type MemoryCandidateDraft,
} from './extract.js';

/** Extract and assert exactly one candidate, returning it for further checks. */
function single(text: string): MemoryCandidateDraft {
  const drafts = extractMemoryCandidates(text);
  expect(drafts).toHaveLength(1);
  return drafts[0];
}

describe('extractMemoryCandidates — classification', () => {
  it('classifies a decision (결정) with strong confidence', () => {
    const draft = single('우리는 PostgreSQL 파티셔닝을 도입하기로 결정');
    expect(draft.type).toBe('decision');
    expect(draft.confidence).toBe(90);
  });

  it('classifies an incident only with an incident keyword AND resolution context', () => {
    const draft = single('Route53 인증서 만료 장애를 ACM 재발급으로 해결');
    expect(draft.type).toBe('incident');
    expect(draft.confidence).toBe(90);
  });

  it('treats an incident keyword without resolution context as a fact', () => {
    // '오류' is an incident keyword but there is no 해결/복구/조치 marker.
    const draft = single('어제 배포에서 심각한 오류가 발생했다');
    expect(draft.type).toBe('fact');
    expect(draft.confidence).toBe(60);
  });

  it('classifies a task (담당) with strong confidence', () => {
    const draft = single('수빈이 마이그레이션 스크립트 작성 담당');
    expect(draft.type).toBe('task');
    expect(draft.confidence).toBe(90);
  });

  it('classifies "하기로 했" as a task, taking priority over decision', () => {
    // Contains the decision substring '하기로', but '하기로 했' is a task marker
    // and is checked first.
    const draft = single('내일 오전에 배포하기로 했다');
    expect(draft.type).toBe('task');
  });

  it('classifies a procedure (절차/순서)', () => {
    const draft = single('배포 절차는 다음 순서를 따른다');
    expect(draft.type).toBe('procedure');
    expect(draft.confidence).toBe(90);
  });

  it('classifies a preference (선호)', () => {
    const draft = single('나는 다크 모드를 선호한다');
    expect(draft.type).toBe('preference');
    expect(draft.confidence).toBe(90);
  });

  it('falls back to fact with weak confidence for an informative sentence', () => {
    const draft = single('서울 본사는 강남구 테헤란로에 위치한다');
    expect(draft.type).toBe('fact');
    expect(draft.confidence).toBe(60);
  });

  it('matches English keywords case-insensitively', () => {
    expect(single('We decided to adopt table partitioning').type).toBe('decision');
    expect(single('How to deploy the service in three steps').type).toBe('procedure');
  });
});

describe('extractMemoryCandidates — noise & empty input', () => {
  it('skips short chit-chat and returns an empty array', () => {
    expect(extractMemoryCandidates('ㅋㅋㅋ')).toEqual([]);
    expect(extractMemoryCandidates('ㅋㅋ\nㅇㅇ\n네네')).toEqual([]);
  });

  it('returns an empty array for empty / whitespace-only input', () => {
    expect(extractMemoryCandidates('')).toEqual([]);
    expect(extractMemoryCandidates('   \n\t  ')).toEqual([]);
  });
});

describe('extractMemoryCandidates — subject / content limits', () => {
  it('caps subject at 120 chars and content at 500 chars', () => {
    // Single line (no sentence terminator) so the whole thing is the key phrase.
    const text = `결정 ${'가'.repeat(600)}`;
    const draft = single(text);

    expect(draft.type).toBe('decision');
    expect(draft.subject.length).toBe(120);
    expect(draft.content.length).toBe(500);
    expect(draft.subject.length).toBeLessThanOrEqual(120);
    expect(draft.content.length).toBeLessThanOrEqual(500);
  });

  it('uses the first sentence as the subject when a terminator is present', () => {
    const draft = single('강남에 위치한다. 추가 세부사항은 위키를 참고한다.');
    expect(draft.subject).toBe('강남에 위치한다.');
  });
});

describe('extractMemoryCandidates — multiple candidates', () => {
  it('emits one candidate per informative paragraph', () => {
    const text = [
      '우리는 파티셔닝을 도입하기로 결정',
      '수빈이 인덱싱 스크립트 작성 담당',
      '서울 본사는 강남구 테헤란로에 위치한다',
    ].join('\n');

    const drafts = extractMemoryCandidates(text);

    expect(drafts.map((d) => d.type)).toEqual(['decision', 'task', 'fact']);
  });

  it('de-duplicates identical (type, subject) drafts within one text', () => {
    const line = '수빈이 인덱싱 스크립트 작성 담당';
    const drafts = extractMemoryCandidates(`${line}\n${line}`);

    expect(drafts).toHaveLength(1);
    expect(drafts[0].type).toBe('task');
  });
});
