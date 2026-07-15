import { Global, Inject, Module } from '@nestjs/common';
import type { OnModuleDestroy, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '@family/config';
import { createDbClient, type Db } from '@family/database';
import type { Sql } from 'postgres';

/** drizzle Db 인스턴스 주입 토큰 */
export const DB = 'DB';

/** 내부 연결 번들({ db, client }) 토큰 — 종료 시 client.end()에 사용 */
export const DB_CONNECTION = 'DB_CONNECTION';

interface DbConnection {
  db: Db;
  client: Sql;
}

const dbConnectionProvider: Provider = {
  provide: DB_CONNECTION,
  inject: [ConfigService],
  useFactory: (configService: ConfigService): DbConnection => {
    const database = configService.get<AppConfig['database']>('database');
    if (!database?.url) {
      throw new Error('Database configuration is missing (database.url)');
    }
    return createDbClient(database.url);
  },
};

const dbProvider: Provider = {
  provide: DB,
  inject: [DB_CONNECTION],
  useFactory: (connection: DbConnection): Db => connection.db,
};

@Global()
@Module({
  providers: [dbConnectionProvider, dbProvider],
  exports: [DB],
})
export class DatabaseModule implements OnModuleDestroy {
  constructor(@Inject(DB_CONNECTION) private readonly connection: DbConnection) {}

  async onModuleDestroy(): Promise<void> {
    try {
      await this.connection.client.end({ timeout: 5 });
    } catch {
      // 종료 시 연결 정리 실패가 graceful shutdown을 막지 않도록 무시한다.
    }
  }
}
