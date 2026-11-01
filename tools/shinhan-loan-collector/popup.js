import { collectShinhanLoans } from './collector.js';
import { isSanitizedCapture, serializeSelectedCapture } from './export.js';

const captureButton = document.getElementById('capture');
const exportButton = document.getElementById('export');
const status = document.getElementById('status');
const review = document.getElementById('review');
const select = document.getElementById('loan');
const confirmed = document.getElementById('confirmed');
const details = document.getElementById('details');
let captures = [];

const errors = {
  WRONG_ORIGIN: 'https://bank.shinhan.com의 대출계좌명세 화면에서 실행해 주세요.',
  UNSUPPORTED_FRAME: '프레임 안의 화면은 지원하지 않습니다.',
  UNSUPPORTED_PAGE: '지원되는 대출계좌명세 화면을 확인할 수 없습니다.',
  NO_SUPPORTED_TABLE: '지원되는 대출계좌명세 표가 없습니다. 프레임 안의 표는 읽지 않습니다.',
  AMBIGUOUS_TABLE: '대출잔액 표가 여러 개여서 중단했습니다.',
  AMBIGUOUS_COLUMNS: '계좌번호·대출잔액·만기일 열을 하나씩 확인할 수 없습니다.',
  UNSUPPORTED_LAYOUT: '지원되지 않는 표 구조입니다.',
  INVALID_ACCOUNT: '마스킹되지 않은 전체 계좌번호를 명확히 확인할 수 없습니다.',
  INVALID_AMOUNT: '현재 대출잔액을 정확한 원 단위 정수로 확인할 수 없습니다.',
  MISSING_KRW_UNIT: '원화(KRW) 단위를 명확히 확인할 수 없습니다.',
  INVALID_MATURITY: '만기일 또는 명시적인 미표시 기호를 확인할 수 없습니다.',
  AMBIGUOUS_LOAN_TYPE: '중도금·전세 대출 유형을 하나로 확인할 수 없습니다.',
  DUPLICATE_ACCOUNT: '같은 계좌가 여러 행에 있어 중단했습니다.',
  NO_ELIGIBLE_LOAN: '지원되는 중도금·전세 대출 행이 없습니다.',
  CRYPTO_UNAVAILABLE: '계좌 지문을 안전하게 계산할 수 없습니다.',
};
const amountLabel = (value) => `${value.replace(/\B(?=([0-9]{3})+(?![0-9]))/gu, ',')}원`;
const loanLabel = (value) => value.loanType === 'interim' ? '중도금' : '전세';
const selected = () => select.value === '' ? null : captures[Number(select.value)] ?? null;
const resetReview = () => {
  captures = [];
  select.replaceChildren(new Option('직접 선택해 주세요', ''));
  confirmed.checked = false;
  details.hidden = true;
  review.hidden = true;
  exportButton.disabled = true;
};

captureButton.addEventListener('click', async () => {
  resetReview();
  captureButton.disabled = true;
  status.textContent = '현재 탭의 지원되는 표를 확인하는 중입니다…';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!Number.isInteger(tab?.id)) throw new Error('NO_TAB');
    const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: collectShinhanLoans });
    if (results.length !== 1 || results[0].frameId !== 0) throw new Error('INVALID_RESULT');
    const result = results[0].result;
    if (result?.ok !== true) {
      status.textContent = Object.hasOwn(errors, result?.error) ? errors[result.error] : errors.UNSUPPORTED_PAGE;
      return;
    }
    if (!Array.isArray(result.captures) || result.captures.length === 0 || !result.captures.every(isSanitizedCapture)) throw new Error('INVALID_RESULT');
    captures = result.captures;
    captures.forEach((capture, index) => select.append(new Option(
      `${loanLabel(capture)} · 끝 ${capture.accountLast4} · ${amountLabel(capture.outstandingPrincipalKrw)}`, String(index),
    )));
    review.hidden = false;
    status.textContent = `${captures.length}개 대출을 확인했습니다. 저장할 대출 하나를 직접 선택해 주세요.`;
  } catch {
    resetReview();
    status.textContent = '현재 탭을 확인할 수 없습니다. 은행 화면과 확장 기능 권한을 직접 확인해 주세요.';
  } finally {
    captureButton.disabled = false;
  }
});

select.addEventListener('change', () => {
  confirmed.checked = false;
  exportButton.disabled = true;
  const capture = selected();
  details.hidden = !capture;
  if (!capture) return;
  document.getElementById('identity').textContent = `${loanLabel(capture)} · ${capture.accountLast4}`;
  document.getElementById('principal').textContent = amountLabel(capture.outstandingPrincipalKrw);
  document.getElementById('maturity').textContent = capture.maturityDate ?? '명시적으로 표시되지 않음';
  document.getElementById('captured-at').textContent = capture.capturedAt;
});
confirmed.addEventListener('change', () => { exportButton.disabled = !confirmed.checked || !selected(); });

exportButton.addEventListener('click', () => {
  if (!confirmed.checked || !selected()) return;
  try {
    const blob = new Blob([serializeSelectedCapture(selected())], { type: 'application/json' });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = 'shinhan-loan-capture.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    status.textContent = '선택한 대출 파일의 저장을 요청했습니다. 가계 앱에서 가져온 뒤 다시 검토해 주세요.';
  } catch {
    status.textContent = '파일을 만들 수 없습니다. 다시 확인해 주세요.';
  }
});
