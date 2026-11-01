// A second narrow boundary before popup rendering and disk export.
const fields = [
  'formatVersion', 'provider', 'source', 'origin', 'pageKind', 'capturedAt',
  'accountFingerprint', 'accountLast4', 'loanType', 'outstandingPrincipalKrw',
  'maturityDate', 'bankAsOfDate',
];
const fullMatch = (pattern, value) => typeof value === 'string' && pattern.exec(value)?.[0] === value;

function realDate(value) {
  if (!fullMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u, value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return year > 0 && month >= 1 && month <= 12 && day >= 1
    && day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

export function isSanitizedCapture(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field))
    && value.formatVersion === 1 && value.provider === 'shinhan' && value.source === 'browser_assisted'
    && value.origin === 'https://bank.shinhan.com' && value.pageKind === 'loan_account_list'
    && fullMatch(/^[0-9a-f]{64}$/u, value.accountFingerprint)
    && fullMatch(/^[0-9]{4}$/u, value.accountLast4)
    && ['interim', 'jeonse'].includes(value.loanType)
    && fullMatch(/^(0|[1-9][0-9]{0,19})$/u, value.outstandingPrincipalKrw)
    && (value.maturityDate === null || realDate(value.maturityDate))
    && value.bankAsOfDate === null
    && fullMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u, value.capturedAt)
    && realDate(value.capturedAt.slice(0, 10))
    && Number.isFinite(Date.parse(value.capturedAt))
    && new Date(value.capturedAt).toISOString() === value.capturedAt;
}

export function serializeSelectedCapture(value) {
  if (!isSanitizedCapture(value)) throw new Error('INVALID_CAPTURE');
  const sanitized = Object.fromEntries(fields.map((field) => [field, value[field]]));
  return `${JSON.stringify(sanitized, null, 2)}\n`;
}
