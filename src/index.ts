// src/index.ts
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from 'jsonwebtoken';
import swagger from '@fastify/swagger';
import swaggerUI from '@fastify/swagger-ui';

import { CONFIG } from './config';
import { initDb, getDb } from './db';
import { registerRoutes } from './routes';
import { registerSchemas } from './schemas/schemas'; // ⬅️ AQUÍ EL CAMBIO

/* ───────────────────────────────────────────────
 * Crear instancia Fastify
 * ─────────────────────────────────────────────── */
const app = Fastify({
  logger: CONFIG.NODE_ENV === 'production'
    ? { level: 'warn' }
    : { level: 'info' },
});

/* ───────────────────────────────────────────────
 * Bootstrap principal
 * ─────────────────────────────────────────────── */
async function bootstrap() {

  /* ───────── Middlewares base ───────── */
  await app.register(cors, {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });

  /* ───────── Home / Health ───────── */
  const HTML_CT = 'text/html; charset=UTF-8';
  const JSON_CT = 'application/json; charset=UTF-8';

  const homeHtml = () => `
    <!doctype html>
    <html>
      <head><meta charset="utf-8"><title>RAFC API</title></head>
      <body>
        <h1>Real Academy FC Reload — API</h1>
        <p>Status: online</p>
        <p>Environment: ${CONFIG.NODE_ENV}</p>
        <p>Timestamp: ${new Date().toISOString()}</p>
      </body>
    </html>`;

  const healthJson = (req: any) => ({
    ok: true,
    env: CONFIG.NODE_ENV,
    path: req.url,
    time: new Date().toISOString(),
  });

  app.get('/', async (_req, reply) =>
    reply.header('Content-Type', HTML_CT).send(homeHtml())
  );

  app.get('/api', async (_req, reply) =>
    reply.header('Content-Type', HTML_CT).send(homeHtml())
  );

  app.get('/health', async (req, reply) =>
    reply.header('Content-Type', JSON_CT).send(healthJson(req))
  );

  app.get('/api/health', async (req, reply) =>
    reply.header('Content-Type', JSON_CT).send(healthJson(req))
  );

  /* ───────── Favicon / robots ───────── */
  app.get('/favicon.ico', async (_req, reply) => reply.code(204).send());
  app.get('/robots.txt', async (_req, reply) =>
    reply.header('Content-Type', 'text/plain; charset=UTF-8')
      .send('User-agent: *\nDisallow:\n')
  );

  /* ───────── Swagger (solo en dev) ───────── */
  if (CONFIG.NODE_ENV !== 'production') {
    await app.register(swagger, {
      openapi: {
        info: {
          title: 'RAFC Reload API',
          description: 'Backend Node/Fastify — Real Academy FC Reload',
          version: '1.0.0',
        },
        servers: [
          { url: `http://127.0.0.1:${CONFIG.PORT || 8000}`, description: 'Local' },
          { url: 'https://realacademyfc.cl/api', description: 'Producción' },
        ],
        components: {
          securitySchemes: {
            bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          },
        },
        security: [{ bearerAuth: [] }],
      },
    });

    await app.register(swaggerUI, {
      routePrefix: '/docs',
      uiConfig: { docExpansion: 'list', deepLinking: true },
    });
  }

  /* ───────── Inicializar BD ───────── */
  await initDb();

  /* ───────── Registrar Schemas globales ───────── */
  await registerSchemas(app);

  /* ───────── Autenticación global JWT ───────── */
  const PUBLIC = [
    /^\/$/i,
    /^\/api$/i,
    /^\/health(?:\/.*)?$/i,
    /^\/api\/health(?:\/.*)?$/i,
    /^\/auth\/login$/i,
    /^\/auth\/logout$/i,
    /^\/docs(?:\/.*)?$/i,
    /^\/swagger(?:\/.*)?$/i,
    /^\/favicon\.ico$/i,
    /^\/robots\.txt$/i,
  ];

  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'OPTIONS' || req.method === 'HEAD') return;

    if (PUBLIC.some((rx) => rx.test(req.url))) return;

    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      return reply.code(401).send({ ok: false, message: 'Falta Bearer token' });
    }

    try {
      const token = auth.slice(7);
      const payload: any = jwt.verify(token, CONFIG.JWT_SECRET);

      (req as any).user = {
        id: payload.sub,
        rol_id: payload.rol_id,
        nombre_usuario: payload.nombre_usuario,
      };
    } catch {
      return reply.code(401).send({ ok: false, message: 'Token inválido o expirado' });
    }
  });

  /* ───────── Registrar rutas de negocio ───────── */
  await registerRoutes(app);

  /* ───────── Shutdown limpio ───────── */
  const close = async () => {
    app.log.info('Shutting down gracefully...');

    try {
      await app.close();

      try {
        const pool = getDb();
        await pool.end();
        app.log.info('MySQL pool closed');
      } catch (e) {
        app.log.error(e, 'Pool close error');
      }

      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', close);
  process.on('SIGTERM', close);

  /* ───────── Levantar servidor ───────── */
  const PORT = Number(process.env.PORT) || CONFIG.PORT || 8000;
  const HOST = '0.0.0.0';

  await app.listen({ port: PORT, host: HOST });
  app.log.info(`🟢 Server ready (env=${CONFIG.NODE_ENV}) — listening on ${HOST}:${PORT}`);
}

/* ───────── Ejecutar bootstrap ───────── */
bootstrap().catch((err) => {
  app.log.error(err, '❌ Fatal error on bootstrap');
  process.exit(1);
});
