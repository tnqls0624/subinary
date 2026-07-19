/**
 * 운영 DB를 변경하지 않고 가맹점 라벨 후보의 권한·집계 경계를 검증한다.
 * 빌드된 API 컨테이너에서 표준 입력으로 실행한다.
 */
const { createRequire } = require('node:module');
const path = require('node:path');

const apiRoot = path.join(process.cwd(), 'apps/api');
const apiRequire = createRequire(path.join(apiRoot, 'package.json'));
apiRequire('reflect-metadata');
const postgres = apiRequire('postgres');
const { drizzle } = apiRequire('drizzle-orm/postgres-js');

const { TransactionService } = require(
  path.join(apiRoot, 'dist/transactions/transaction.service.js'),
);

const NON_MEMBER_USER_ID = '00000000-0000-4000-8000-000000000000';

function statusOf(error) {
  return typeof error?.getStatus === 'function' ? error.getStatus() : null;
}

async function expectStatus(action, expectedStatus) {
  try {
    await action();
  } catch (error) {
    if (statusOf(error) === expectedStatus) return;
    throw error;
  }
  throw new Error(`expected HTTP ${expectedStatus} error`);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }

  const client = postgres(process.env.DATABASE_URL, { max: 1 });
  try {
    const db = drizzle(client);
    const service = new TransactionService(db);
    const actors = await client`
      select
        hm.id as member_id,
        hm.user_id,
        hm.household_id,
        hm.role
      from household_members hm
      where hm.status = 'active'
      order by hm.created_at asc
      limit 20
    `;

    if (actors.length === 0) {
      throw new Error('active household member is required');
    }

    let candidatesChecked = 0;
    for (const actor of actors) {
      const result = await service.listMerchantLabelCandidates(
        actor.user_id,
        actor.household_id,
        '100',
      );
      const firstPage = await service.listMerchantLabelCandidates(
        actor.user_id,
        actor.household_id,
        '1',
      );
      if (firstPage.hasMore !== (result.items.length > 1)) {
        throw new Error('candidate hasMore mismatch');
      }

      for (const candidate of result.items) {
        const [transaction] = await client`
          select member_id, visibility, transaction_type, excluded_at,
                 merchant_normalized
          from card_transactions
          where id = ${candidate.representativeTransactionId}
        `;
        if (!transaction) {
          throw new Error('representative transaction not found');
        }

        const privileged = actor.role === 'owner' || actor.role === 'admin';
        const mutable =
          transaction.member_id === actor.member_id ||
          (privileged && transaction.visibility === 'household');
        if (!mutable) {
          throw new Error('candidate privacy scope violation');
        }
        if (
          transaction.transaction_type !== 'approval' ||
          transaction.excluded_at !== null ||
          transaction.merchant_normalized !== candidate.merchantNormalized
        ) {
          throw new Error('candidate transaction eligibility mismatch');
        }

        const [aggregate] = await client`
          select count(*)::int as count
          from card_transactions ct
          left join merchant_category_rules mr
            on mr.household_id = ct.household_id
           and mr.merchant_pattern = ct.merchant_normalized
          where ct.household_id = ${actor.household_id}
            and ct.transaction_type = 'approval'
            and ct.excluded_at is null
            and ct.merchant_normalized = ${candidate.merchantNormalized}
            and (
              ct.member_id = ${actor.member_id}
              or (${privileged} and ct.visibility = 'household')
            )
            and (mr.id is null or mr.source = 'model_prediction')
        `;
        if (aggregate.count !== candidate.transactionCount) {
          throw new Error('candidate aggregate count mismatch');
        }
        candidatesChecked += 1;
      }
    }

    const firstActor = actors[0];
    await expectStatus(
      () =>
        service.listMerchantLabelCandidates(
          firstActor.user_id,
          firstActor.household_id,
          '0',
        ),
      400,
    );
    await expectStatus(
      () =>
        service.listMerchantLabelCandidates(
          NON_MEMBER_USER_ID,
          firstActor.household_id,
          '20',
        ),
      403,
    );

    console.log(
      JSON.stringify({
        status: 'PASS',
        actorsChecked: actors.length,
        candidatesChecked,
        privacyViolations: 0,
        aggregateMismatches: 0,
        invalidLimitRejected: true,
        nonMemberRejected: true,
      }),
    );
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
