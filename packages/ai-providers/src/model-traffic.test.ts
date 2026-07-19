import { describe, expect, it, vi } from 'vitest';

import { executeLlmTraffic } from './model-traffic.js';
import type {
  GenerateRequest,
  GenerateResponse,
  LlmProvider,
} from './types.js';

function response(model: string): GenerateResponse {
  return {
    text: model,
    model,
    finishReason: 'stop',
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

function provider(
  model: string,
  generate: (request: GenerateRequest) => Promise<GenerateResponse>,
): LlmProvider {
  return { provider: 'test', model, generate };
}

const request: GenerateRequest = { prompt: 'test' };

describe('executeLlmTraffic', () => {
  it('shadow 후보 결과를 폐기하고 primary 응답을 반환한다', async () => {
    const primary = provider('primary', async () => response('primary'));
    const candidateGenerate = vi.fn(async () => response('candidate'));
    const candidate = provider('candidate', candidateGenerate);

    const result = await executeLlmTraffic({
      mode: 'shadow',
      executeCandidate: true,
      primaryProvider: primary,
      candidateProvider: candidate,
      primaryRequest: request,
      candidateRequest: request,
    });

    expect(result.model).toBe('primary');
    expect(candidateGenerate).toHaveBeenCalledOnce();
  });

  it('live 후보가 성공하면 candidate 응답을 반환한다', async () => {
    const primaryGenerate = vi.fn(async () => response('primary'));
    const result = await executeLlmTraffic({
      mode: 'live',
      executeCandidate: true,
      primaryProvider: provider('primary', primaryGenerate),
      candidateProvider: provider('candidate', async () =>
        response('candidate'),
      ),
      primaryRequest: request,
      candidateRequest: request,
    });

    expect(result.model).toBe('candidate');
    expect(primaryGenerate).not.toHaveBeenCalled();
  });

  it('live 후보 실패 시 primary로 폴백하고 오류 callback을 호출한다', async () => {
    const onCandidateError = vi.fn();
    const result = await executeLlmTraffic({
      mode: 'live',
      executeCandidate: true,
      primaryProvider: provider('primary', async () => response('primary')),
      candidateProvider: provider('candidate', async () => {
        throw new Error('candidate failed');
      }),
      primaryRequest: request,
      candidateRequest: request,
      onCandidateError,
    });

    expect(result.model).toBe('primary');
    expect(onCandidateError).toHaveBeenCalledOnce();
  });

  it('할당 제외 요청에서는 후보를 호출하지 않는다', async () => {
    const candidateGenerate = vi.fn(async () => response('candidate'));
    const result = await executeLlmTraffic({
      mode: 'live',
      executeCandidate: false,
      primaryProvider: provider('primary', async () => response('primary')),
      candidateProvider: provider('candidate', candidateGenerate),
      primaryRequest: request,
      candidateRequest: request,
    });

    expect(result.model).toBe('primary');
    expect(candidateGenerate).not.toHaveBeenCalled();
  });
});
