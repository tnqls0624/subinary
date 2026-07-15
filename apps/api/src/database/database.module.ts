import {
  Global,
  Inject,
  Logger,
  Module,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Sql } from 'postgres';

import type { AppConfig } from '@family/config';
import { createDbClient, type Db } from '@family/database';

import { DB, DB_CONNECTION } from './database.constants';

interface DbConnection {
  db: Db;
  client: Sql;
}

@Global()
@Module({
  providers: [
    {
      provide: DB_CONNECTION,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): DbConnection => {
        const database = configService.get<AppConfig['database']>('database');
        if (!database) {
          throw new Error('Database configuration is missing');
        }
        return createDbClient(database.url);
      },
    },
    {
      provide: DB,
      inject: [DB_CONNECTION],
      useFactory: (connection: DbConnection): Db => connection.db,
    },
  ],
  exports: [DB],
})
export class DatabaseModule implements OnModuleDestroy {
  private readonly logger = new Logger(DatabaseModule.name);

  constructor(
    @Inject(DB_CONNECTION) private readonly connection: DbConnection,
  ) {}

  async onModuleDestroy(): Promise<void> {
    try {
      await this.connection.client.end({ timeout: 5 });
      this.logger.log('Database connection closed');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn(`Failed to close database connection: ${message}`);
    }
  }
}
