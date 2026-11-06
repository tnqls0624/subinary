import { SUJAIN_ORIGINS, SUJAIN_PATHS } from './urls.mjs';

export const ERRORS = new Set([
  'credentials_invalid',
  'authentication_required',
  'network_error',
  'unsupported_layout',
  'runtime_unavailable',
  'operation_unknown',
]);

export class SujainReadError extends Error {
  constructor(code) {
    super('Sujain read did not complete');
    this.code = ERRORS.has(code) ? code : 'operation_unknown';
  }
}

const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const full = (pattern, value) => typeof value === 'string' && pattern.exec(value)?.[0] === value;

export function validateJob(value) {
  if (!exact(value, ['provider', 'credentials']) || value.provider !== 'sujain'
    || !exact(value.credentials, ['loginId', 'password'])
    || !full(/^[A-Za-z0-9._@-]{1,64}$/u, value.credentials.loginId)
    || !full(/^[\x21-\x7e]{1,64}$/u, value.credentials.password)) {
    throw new SujainReadError('operation_unknown');
  }
  return value;
}

/** www.sujain.co.kr · m.sujain.co.kr 만 허용. 호반·공개 분양 소개 호스트는 막는다. */
export function allowedRequest(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    return SUJAIN_ORIGINS.has(url.origin);
  } catch {
    return false;
  }
}

export function isLoginUrl(value) {
  try {
    const url = new URL(value);
    return SUJAIN_ORIGINS.has(url.origin) && (url.pathname === SUJAIN_PATHS.login || url.pathname.startsWith('/login'));
  } catch {
    return false;
  }
}

export { SUJAIN_PATHS };
