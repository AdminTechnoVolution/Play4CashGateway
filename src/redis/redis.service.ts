import { Injectable, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';

@Injectable()
export class RedisService {
  constructor(
    @Inject('REDIS_CLIENT') private readonly client: Redis,
    private readonly configService: ConfigService,
  ) {}

  async isTokenValid(token: string): Promise<boolean> {
    const prefix = this.configService.get<string>(
      'REDIS_TOKEN_PREFIX',
      'accessToken:',
    );
    const key = `${prefix}${token}`;
    const value = await this.client.get(key);
    return value !== null;
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttl?: number): Promise<void> {
    if (ttl) {
      await this.client.set(key, value, 'EX', ttl);
    } else {
      await this.client.set(key, value);
    }
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }
}
