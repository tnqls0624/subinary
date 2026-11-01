import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import type { Db } from '@family/database';
import { assertLoanCaptureTime, loanCommitHash } from './loan-import.policy';
import { FinancialOverviewController, LoanImportController } from './loan-import.controller';
import { LoanImportService } from './loan-import.service';

const NOW = Date.parse('2026-11-01T10:00:00Z');
const U = '22222222-2222-4222-8222-222222222222';
const H = '11111111-1111-4111-8111-111111111111';

describe('reviewed browser loan boundary', () => {
  it('accepts exactly the documented observation clock window', () => {
    expect(() => assertLoanCaptureTime(new Date(NOW - 86_400_000).toISOString(), NOW)).not.toThrow();
    expect(() => assertLoanCaptureTime(new Date(NOW + 120_000).toISOString(), NOW)).not.toThrow();
    expect(() => assertLoanCaptureTime(new Date(NOW - 86_400_001).toISOString(), NOW)).toThrow('loan_capture_stale');
    expect(() => assertLoanCaptureTime(new Date(NOW + 120_001).toISOString(), NOW)).toThrow('loan_capture_future');
    expect(() => assertLoanCaptureTime('invalid', NOW)).toThrow('loan_capture_future');
  });

  it('binds a canonical request to its authenticated author and all review choices', () => {
    const input = { recordId: 'synthetic', capture: { principal: '10', bankAsOfDate: null }, visibility: 'private' };
    const reordered = { visibility: 'private', capture: { bankAsOfDate: null, principal: '10' }, recordId: 'synthetic' };
    expect(loanCommitHash(U, input)).toBe(loanCommitHash(U, reordered));
    expect(loanCommitHash(U, input)).not.toBe(loanCommitHash('another-owner', input));
    expect(loanCommitHash(U, input)).not.toBe(loanCommitHash(U, { ...input, visibility: 'household' }));
    expect(loanCommitHash(U, input)).not.toBe(loanCommitHash(U, { ...input, capture: { principal: '11', bankAsOfDate: null } }));
    expect(loanCommitHash(U, input)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps both controllers under normal JWT authentication with no machine/public bypass', () => {
    expect(Reflect.getMetadata(PATH_METADATA, LoanImportController)).toBe('loan-imports');
    expect(Reflect.getMetadata(PATH_METADATA, FinancialOverviewController)).toBe('financial-overview');
    for (const [controller, methods] of [[LoanImportController, ['preview', 'commit', 'records', 'update', 'remove']],
      [FinancialOverviewController, ['overview']]] as const) {
      expect(Reflect.getMetadata('isPublic', controller)).toBeUndefined();
      for (const name of methods) {
        const method = (controller.prototype as unknown as Record<string, object>)[name]!;
        expect(Reflect.getMetadata(METHOD_METADATA, method)).toBeDefined();
        expect(Reflect.getMetadata('isPublic', method)).toBeUndefined();
      }
    }
  });

  it('rejects bad principal and malformed service requests before any database access', async () => {
    const transaction = vi.fn();
    const service = new LoanImportService({ transaction } as unknown as Db);
    await expect(service.records('', H)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(service.records(U, 'bad-household')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.overview(U, { householdId: H, scope: 'household', ownerUserId: U } as never)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.commit(U, { householdId: H, ownerUserId: U } as never)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.update(U, H, H, { expectedVersion: 1, outstandingPrincipalKrw: '1' } as never)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.remove(U, H, H, { expectedVersion: 0 })).rejects.toBeInstanceOf(BadRequestException);
    expect(transaction).not.toHaveBeenCalled();
  });
});
