import type {
  GenerateRequest,
  GenerateResponse,
  LlmProvider,
} from './types.js';

/** {@link executeLlmTraffic} 입력. */
export interface ExecuteLlmTrafficInput {
  mode: 'shadow' | 'live';
  executeCandidate: boolean;
  primaryProvider: LlmProvider;
  candidateProvider: LlmProvider;
  primaryRequest: GenerateRequest;
  candidateRequest: GenerateRequest;
  onCandidateError?: () => void;
}

/**
 * 이미 검증·할당된 LLM 요청을 실행한다. shadow 결과는 폐기하고, live 후보 실패는
 * primary로 폴백해 후보 장애가 사용자 요청으로 전파되지 않게 한다.
 */
export async function executeLlmTraffic(
  input: ExecuteLlmTrafficInput,
): Promise<GenerateResponse> {
  if (!input.executeCandidate) {
    return input.primaryProvider.generate(input.primaryRequest);
  }
  if (input.mode === 'shadow') {
    void input.candidateProvider.generate(input.candidateRequest).catch(() => {
      input.onCandidateError?.();
    });
    return input.primaryProvider.generate(input.primaryRequest);
  }
  try {
    return await input.candidateProvider.generate(input.candidateRequest);
  } catch {
    input.onCandidateError?.();
    return input.primaryProvider.generate(input.primaryRequest);
  }
}
