import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ProxyMiddleware } from './proxy.middleware';

@Module({
  imports: [ConfigModule],
})
export class ProxyModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Proxy ALL /api/* routes to the downstream
    consumer
      .apply(ProxyMiddleware)
      .forRoutes({ path: 'api/*', method: RequestMethod.ALL });
  }
}
