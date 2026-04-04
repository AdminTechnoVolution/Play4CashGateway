import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WsProxyGateway } from './ws-proxy.gateway';

@Module({
  imports: [ConfigModule],
  providers: [WsProxyGateway],
})
export class WsProxyModule {}
