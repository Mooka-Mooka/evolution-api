import { ConfigService, Database } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { Prisma, PrismaClient } from '@prisma/client';

export class Query<T> {
  where?: T;
  sort?: 'asc' | 'desc';
  page?: number;
  offset?: number;
}

export class PrismaRepository extends PrismaClient {
  constructor(private readonly configService: ConfigService) {
    const database = configService.get<Database>('DATABASE');
    let uri = database.CONNECTION.URI;
    if (database.PROVIDER === 'mysql' && uri) {
      // Shared hosts expose CPU counts unrelated to their per-account connection quota.
      // Reuse a small pool by default, while preserving explicit operator settings.
      const parameters = new URL(uri).searchParams;
      const defaults = { connection_limit: '2', pool_timeout: '30' };
      for (const [name, value] of Object.entries(defaults)) {
        if (!parameters.has(name)) uri += `${uri.includes('?') ? '&' : '?'}${name}=${value}`;
      }
    }
    super(uri && database.PROVIDER === 'mysql' ? { datasourceUrl: uri } : undefined);
  }

  private readonly logger = new Logger('PrismaRepository');

  public get isMysql(): boolean {
    return this.configService.get<Database>('DATABASE').PROVIDER === 'mysql';
  }

  public jsonPath(...segments: string[]): Prisma.JsonFilterBase<'Message'>['path'] {
    // Prisma generates a different path type for each provider; match that provider at runtime.
    const path = this.isMysql ? '$' + segments.map((segment) => `.${JSON.stringify(segment)}`).join('') : segments;
    return path as Prisma.JsonFilterBase<'Message'>['path'];
  }

  public async onModuleInit() {
    await this.$connect();
    this.logger.info('Repository:Prisma - ON');
  }

  public async onModuleDestroy() {
    await this.$disconnect();
    this.logger.warn('Repository:Prisma - OFF');
  }
}
