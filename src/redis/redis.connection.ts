import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis, { RedisOptions } from 'ioredis';

const logger = new Logger('GatewayRedis');

/** Do not serve requests until Redis is ready; never buffer commands during an outage. */
export async function createGatewayRedis(config: ConfigService): Promise<Redis> {
  const url = config.get<string>('REDIS_URL')?.trim();
  const uri = config.get<string>('REDIS_URI')?.trim();
  if (url && uri && url !== uri) {
    throw new Error('REDIS_URL y REDIS_URI son distintos: eliminar REDIS_URL antiguo o usar el mismo valor.');
  }
  const connection = url || uri;
  const options: RedisOptions = {
    lazyConnect: true,
    enableAutoPipelining: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: 2000,
    connectTimeout: 10000,
  };
  if (connection) {
    let protocol: string;
    try { protocol = new URL(connection).protocol; } catch { throw new Error('REDIS_URI/REDIS_URL debe ser una URL redis:// o rediss:// válida.'); }
    if (!['redis:', 'rediss:'].includes(protocol)) throw new Error('REDIS_URI/REDIS_URL debe usar redis:// o rediss://.');
  } else {
    const host = config.get<string>('REDIS_HOST')?.trim();
    if (!host && config.get<string>('NODE_ENV') === 'production') throw new Error('Falta conexión Redis: configurar REDIS_URI en el gateway.');
    const port = Number(config.get<string | number>('REDIS_PORT', 6379));
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('REDIS_PORT inválido.');
    Object.assign(options, { host: host || 'localhost', port, password: config.get<string>('REDIS_PASSWORD') || undefined });
  }
  const client = connection ? new Redis(connection, options) : new Redis(options);
  client.on('error', (error: Error & { code?: string }) => {
    const code = /^[A-Z0-9_]{1,60}$/.test(error.code ?? '') ? error.code
      : /WRONGPASS|NOAUTH/.test(error.message) ? 'AUTHENTICATION_FAILED' : 'CONNECTION_FAILED';
    // Never print the original error, URL, password or host connection parameters.
    logger.error(`event=redis_connection_error code=${code}`);
  });
  client.on('ready', () => logger.log('event=redis_ready'));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.connect(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('REDIS_STARTUP_TIMEOUT')), 15000);
      }),
    ]);
    return client;
  } catch {
    client.disconnect();
    throw new Error('GATEWAY_REDIS_NOT_READY: revisar REDIS_URI, TLS, credenciales y acceso de red. El gateway no iniciará sin Redis.');
  } finally {
    if (timer) clearTimeout(timer);
  }
}
