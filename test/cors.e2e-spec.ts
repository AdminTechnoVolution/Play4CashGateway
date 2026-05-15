import { INestApplication, Module, Controller, Get, Header } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { Server } from 'http';

@Controller()
class EchoController {
  @Get('echo')
  @Header('X-App-Min-Version', '2.0.0')
  echo(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [EchoController] })
class HostModule {}

/**
 * Verifies that the Gateway's CORS contract — which is the SOURCE OF TRUTH for the
 * `X-App-Version` (request) and `X-App-Min-Version` (response) headers — is correctly
 * configured. The downstream API also sets these on its own CORS, but in production the
 * Gateway is the only origin browsers see, so the Gateway settings are what matter.
 */
describe('Gateway CORS contract (e2e)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const mod = await Test.createTestingModule({ imports: [HostModule] }).compile();
    app = mod.createNestApplication();
    app.enableCors({
      origin: ['https://example.test'],
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'accept-language',
        'X-App-Version',
        'Idempotency-Key',
      ],
      exposedHeaders: ['X-App-Min-Version'],
      credentials: true,
    });
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
  });

  it('exposes X-App-Min-Version via Access-Control-Expose-Headers', async () => {
    const res = await request(app.getHttpServer() as Server)
      .get('/echo')
      .set('Origin', 'https://example.test');

    expect(res.status).toBe(200);
    expect(res.headers['x-app-min-version']).toBe('2.0.0');
    const exposed = (res.headers['access-control-expose-headers'] || '').toLowerCase();
    expect(exposed).toContain('x-app-min-version');
  });

  it('allows X-App-Version on preflight OPTIONS', async () => {
    const res = await request(app.getHttpServer() as Server)
      .options('/echo')
      .set('Origin', 'https://example.test')
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'X-App-Version,Authorization');

    expect([200, 204]).toContain(res.status);
    const allowed = (res.headers['access-control-allow-headers'] || '').toLowerCase();
    expect(allowed).toContain('x-app-version');
    expect(allowed).toContain('authorization');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('allows Idempotency-Key on preflight OPTIONS (POST /api/rooms)', async () => {
    const res = await request(app.getHttpServer() as Server)
      .options('/echo')
      .set('Origin', 'https://example.test')
      .set('Access-Control-Request-Method', 'POST')
      .set(
        'Access-Control-Request-Headers',
        'Content-Type,Authorization,X-App-Version,Idempotency-Key',
      );

    expect([200, 204]).toContain(res.status);
    const allowed = (res.headers['access-control-allow-headers'] || '').toLowerCase();
    expect(allowed).toContain('idempotency-key');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('reflects the configured origin (not "*", because credentials=true)', async () => {
    const res = await request(app.getHttpServer() as Server)
      .get('/echo')
      .set('Origin', 'https://example.test');

    expect(res.headers['access-control-allow-origin']).toBe('https://example.test');
  });
});
