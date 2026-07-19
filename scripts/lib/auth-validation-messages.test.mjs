import assert from 'node:assert/strict';
import test from 'node:test';

import {
  changePasswordRequestSchema,
  loginRequestSchema,
  registerRequestSchema,
} from '../../packages/contracts/dist/index.js';

/** @param {import('zod').ZodSafeParseError<unknown>} result */
function messages(result) {
  return result.error.issues.map((issue) => issue.message);
}

test('로그인 입력 오류를 한국어로 반환한다', () => {
  const empty = loginRequestSchema.safeParse({ email: '', password: '' });
  assert.equal(empty.success, false);
  assert.deepEqual(messages(empty), [
    '이메일을 입력해 주세요.',
    '비밀번호를 입력해 주세요.',
  ]);

  const invalidEmail = loginRequestSchema.safeParse({
    email: 'invalid',
    password: 'secret',
  });
  assert.equal(invalidEmail.success, false);
  assert.deepEqual(messages(invalidEmail), [
    '올바른 이메일 주소를 입력해 주세요.',
  ]);
});

test('회원가입 입력 오류와 길이 경계를 한국어로 반환한다', () => {
  const empty = registerRequestSchema.safeParse({
    name: '   ',
    email: '',
    password: 'short',
  });
  assert.equal(empty.success, false);
  assert.deepEqual(messages(empty), [
    '이메일을 입력해 주세요.',
    '비밀번호는 8자 이상 입력해 주세요.',
    '이름을 입력해 주세요.',
  ]);

  const tooLong = registerRequestSchema.safeParse({
    name: '가'.repeat(101),
    email: 'user@example.com',
    password: '가'.repeat(201),
  });
  assert.equal(tooLong.success, false);
  assert.deepEqual(messages(tooLong), [
    '비밀번호는 200자 이하로 입력해 주세요.',
    '이름은 100자 이하로 입력해 주세요.',
  ]);
});

test('정상 인증 입력은 공백을 정규화하고 통과한다', () => {
  assert.deepEqual(
    registerRequestSchema.parse({
      name: ' 홍길동 ',
      email: ' user@example.com ',
      password: 'password123',
    }),
    {
      name: '홍길동',
      email: 'user@example.com',
      password: 'password123',
    },
  );

  assert.deepEqual(
    changePasswordRequestSchema.parse({
      currentPassword: 'old-password',
      newPassword: 'new-password',
    }),
    {
      currentPassword: 'old-password',
      newPassword: 'new-password',
    },
  );
});
