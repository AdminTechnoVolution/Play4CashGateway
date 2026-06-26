import { Module, Global } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { RedisService } from './redis.service';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: 'REDIS_CLIENT',
      useFactory: (configService: ConfigService): Redis => {
        const redisUrl =
          configService.get<string>('REDIS_URL') ||
          configService.get<string>('REDIS_URI');
        if (redisUrl) {
          return new Redis(redisUrl, {
            lazyConnect: false,
            enableAutoPipelining: true,
          });
        }
        const portRaw = configService.get<string | number>('REDIS_PORT', 6379);
        const parsedPort =
          typeof portRaw === 'number' ? portRaw : Number.parseInt(String(portRaw), 10);
        return new Redis({
          host: configService.get<string>('REDIS_HOST', 'localhost'),
          port: Number.isFinite(parsedPort) ? parsedPort : 6379,
          password: configService.get<string>('REDIS_PASSWORD') || undefined,
          lazyConnect: false,
          enableAutoPipelining: true,
        });
      },
      inject: [ConfigService],
    },
    RedisService,
  ],
  exports: ['REDIS_CLIENT', RedisService],
})
export class RedisModule {}
