import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { ConnectFourEdgeGateway } from './connect-four-edge.gateway';
import { WsProxyGateway } from './ws-proxy.gateway';

@Module({
  imports: [ConfigModule, AuthModule],
  providers: [WsProxyGateway, ConnectFourEdgeGateway],
})
export class WsProxyModule {}
