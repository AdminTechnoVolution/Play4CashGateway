import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { WsProxyGateway } from './ws-proxy.gateway';

@Module({
  imports: [ConfigModule, AuthModule],
  providers: [WsProxyGateway],
})
export class WsProxyModule {}
