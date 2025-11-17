// src/index.ts
import jwt from 'jsonwebtoken';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import swagger from '@fastify/swagger';
import swaggerUI from '@fastify/swagger-ui';

import { CONFIG } from './config';
import { registerRoutes } from './routes';
import { initDb, pool } from './db';

const app = Fastify({
  logger: CONFIG.NODE_ENV === 'production'
    ? { level: 'warn' }  // solo warnings/errores en prod
    : { level: 'info' }, // más detalle en dev
});


async function bootstrap() {
  /* ───────── Middlewares base ───────── */
  await app.register(cors, {
    origin: true, // refleja Origin
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  await app.register(helmet, {
    contentSecurityPolicy: false, // evita bloquear assets del /docs
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });

  /* ───────── Rutas públicas fijas (con Content-Type estable) ───────── */
  const HTML_CT = 'text/html; charset=UTF-8';
  const JSON_CT = 'application/json; charset=UTF-8';

  const homeHtml = () => (
    `<!doctype html><html><head><meta charset="utf-8"><title>RAFC API</title></head>
     <body>
       <h1>Real Academy FC Reload — API</h1>
       <p>Status: online</p>
       <p>Environment: ${CONFIG.NODE_ENV}</p>
       <p>Timestamp: ${new Date().toISOString()}</p>
     </body></html>`
  );

  const healthJson = (req: any) => ({
    ok: true,
    env: CONFIG.NODE_ENV,
    path: req.url,
    time: new Date().toISOString(),
  });

  // Raíz y alias /api con HTML + charset fijo (para panel de hosting)
  app.get('/', { config: { public: true } }, async (_req, reply) =>
    reply.header('Content-Type', HTML_CT).send(homeHtml())
  );
  app.get('/api', { config: { public: true } }, async (_req, reply) =>
    reply.header('Content-Type', HTML_CT).send(homeHtml())
  );

  // Health JSON + charset fijo
  app.get('/health', { config: { public: true } }, async (req, reply) =>
    reply.header('Content-Type', JSON_CT).send(healthJson(req))
  );
  app.get('/api/health', { config: { public: true } }, async (req, reply) =>
    reply.header('Content-Type', JSON_CT).send(healthJson(req))
  );

  // Extras típicos
  app.get('/favicon.ico', { config: { public: true } }, async (_req, reply) => reply.code(204).send());
  app.get('/robots.txt', { config: { public: true } }, async (_req, reply) =>
    reply.header('Content-Type', 'text/plain; charset=UTF-8').send('User-agent: *\nDisallow:\n')
  );

  /* ───────── Swagger / OpenAPI ───────── */
  /* ───────── Swagger / OpenAPI ───────── */
  if (CONFIG.NODE_ENV !== 'production') {
    await app.register(swagger, {
      openapi: {
        info: {
          title: 'RAFC Reload API',
          description: 'Backend Node/Fastify — RAFC',
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



  /* ───────── DB ───────── */
  await initDb();

  /* ───────── Guard global JWT ───────── */
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
    // Permite preflight y HEAD
    if (req.method === 'OPTIONS' || req.method === 'HEAD') return;

    // Rutas públicas
    if (PUBLIC.some(rx => rx.test(req.url))) return;

    // JWT requerido
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) {
      return reply.code(401).send({ ok: false, message: 'Falta Bearer token' });
    }
    try {
      const token = h.slice(7);
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

  /* ───────── Rutas de negocio ───────── */
  await registerRoutes(app);

  /* ───────── Shutdown limpio ───────── */
  const close = async () => {
    app.log.info('Shutting down gracefully...');
    try {
      await app.close();
      if (pool) await pool.end();
      app.log.info('MySQL pool closed');
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);

  /* ───────── Arranque (puerto dinámico) ─────────
     Importante en Passenger/hosting: NO fijar 8000 si el
     proceso principal del servidor ya lo usa. */
  const PORT = Number(process.env.PORT) || 0; // 0 => sistema elige
  const HOST = '0.0.0.0';

  await app.listen({ port: PORT, host: HOST });
  app.log.info(`🟢 Server ready (env=${CONFIG.NODE_ENV})`);
}

bootstrap().catch((err) => {
  app.log.error(err, '❌ Fatal error on bootstrap');
  process.exit(1);
});
