import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { WsProxyGateway } from './ws-proxy.gateway';
import { WsRateLimiterService } from '../common/rate-limit/ws-rate-limiter.service';

@Module({
  imports: [ConfigModule, AuthModule],
  providers: [WsProxyGateway, WsRateLimiterService],
})
export class WsProxyModule {}
