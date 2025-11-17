// src/routers/auth.ts
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
// ⬇️ reemplazo de argon2 clásico por @node-rs/argon2 (binarios precompilados, sin node-gyp)
import { verify as argon2Verify } from '@node-rs/argon2';
import jwt, { SignOptions } from 'jsonwebtoken';
import { db } from '../db';
import { CONFIG } from '../config';

// -------- Helpers de auditoría --------
type AuditEvent = 'login' | 'logout' | 'refresh' | 'invalid_token' | 'access_denied';

async function audit(
  event: AuditEvent,
  req: FastifyRequest,
  status: number,
  userId?: number | null,
  extra?: any
) {
  try {
    const ip =
      (Array.isArray(req.headers['x-forwarded-for'])
        ? req.headers['x-forwarded-for']?.[0]
        : (req.headers['x-forwarded-for'] as string)) || req.ip;
    const userAgent = (req.headers['user-agent'] as string) || null;
    const route =
      (req.routeOptions && (req.routeOptions.url as string)) ||
      (req as any).routerPath ||
      (req.raw?.url as string) ||
      '';
    const method = req.method || 'GET';

    await db.query(
      `INSERT INTO auth_audit (user_id, event, route, method, status_code, ip, user_agent, extra)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId ?? null,
        event,
        route.substring(0, 255),
        method.substring(0, 10),
        status,
        ip?.toString().substring(0, 64) ?? null,
        userAgent?.substring(0, 255) ?? null,
        extra ? JSON.stringify(extra) : null,
      ]
    );
  } catch (e) {
    (req as any).log?.warn?.({ e }, 'auth_audit insert failed');
  }
}

// -------- Esquema Login --------
const LoginSchema = z.object({
  nombre_usuario: z.string().min(3),
  password: z.string().min(4),
});

export default async function auth(app: FastifyInstance) {
  // Health
  app.get('/health', { schema: { tags: ['Auth'] } }, async () => ({
    module: 'auth',
    status: 'ready',
    timestamp: new Date().toISOString(),
  }));

  // POST /auth/login (público)
  app.post(
    '/login',
    {
      schema: {
        tags: ['Auth'],
        security: [],
        body: {
          type: 'object',
          required: ['nombre_usuario', 'password'],
          properties: {
            nombre_usuario: { type: 'string', minLength: 3 },
            password: { type: 'string', minLength: 4 },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              rafc_token: { type: 'string' },
              rol_id: { type: 'number' },
              user: {
                type: 'object',
                properties: {
                  id: { type: 'number' },
                  nombre_usuario: { type: 'string' },
                  email: { type: 'string' },
                  rol_id: { type: 'number' },
                  estado_id: { type: 'number' },
                },
              },
            },
          },
          401: {
            type: 'object',
            properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
          },
          400: {
            type: 'object',
            properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
          },
        },
        description:
          'Login con nombre_usuario y password (Argon2 via @node-rs/argon2). Devuelve rafc_token (JWT).',
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = LoginSchema.safeParse((req as any).body);
      if (!parsed.success) {
        await audit('access_denied', req, 400, null, { reason: 'invalid_payload' });
        return reply.code(400).send({ ok: false, message: 'Payload inválido' });
      }

      const nombre_usuario = parsed.data.nombre_usuario.trim().toLowerCase();
      const password = parsed.data.password;

      try {
        const [rows]: any = await db.query(
          `SELECT id, nombre_usuario, email, password, rol_id, estado_id
           FROM usuarios
           WHERE LOWER(nombre_usuario) = ?
           LIMIT 1`,
          [nombre_usuario]
        );

        if (!rows || rows.length === 0) {
          await audit('access_denied', req, 401, null, { reason: 'user_not_found', nombre_usuario });
          return reply.code(401).send({ ok: false, message: 'Credenciales inválidas' });
        }

        const user = rows[0] as {
          id: number;
          nombre_usuario: string;
          email: string;
          password: string;
          rol_id: number;
          estado_id: number;
        };

        // ✅ Verifica hash Argon2 con @node-rs/argon2
        const ok = await argon2Verify(user.password, password);
        if (!ok) {
          await audit('access_denied', req, 401, user.id, { reason: 'bad_password' });
          return reply.code(401).send({ ok: false, message: 'Credenciales inválidas' });
        }

        // Firma JWT
        const payload = {
          sub: user.id,
          nombre_usuario: user.nombre_usuario,
          rol_id: user.rol_id,
        };
        const signOpts: SignOptions = {};
        if (CONFIG.JWT_EXPIRES_IN) signOpts.expiresIn = CONFIG.JWT_EXPIRES_IN as any;

        const rafc_token = jwt.sign(payload, CONFIG.JWT_SECRET, signOpts);

        await audit('login', req, 200, user.id);

        return reply.send({
          ok: true,
          rafc_token,
          rol_id: user.rol_id,
          user: {
            id: user.id,
            nombre_usuario: user.nombre_usuario,
            email: user.email,
            rol_id: user.rol_id,
            estado_id: user.estado_id,
          },
        });
      } catch (err: any) {
        req.log.error({ err }, 'auth/login failed');
        await audit('access_denied', req, 400, null, { reason: 'exception', message: err?.message });
        return reply.code(400).send({ ok: false, message: err?.message ?? 'Error procesando login' });
      }
    }
  );

  // POST /auth/logout
  app.post(
    '/logout',
    {
      schema: {
        tags: ['Auth'],
        description:
          'Logout lógico del usuario autenticado. Registra evento en auditoría. Requiere Bearer.',
        response: {
          200: { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' } } },
          401: { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' } } },
        },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId =
          (req as any).user?.id ??
          (() => {
            try {
              const h = req.headers.authorization;
              if (h?.startsWith('Bearer ')) {
                const p: any = jwt.verify(h.slice(7), CONFIG.JWT_SECRET);
                return p?.sub ?? null;
              }
            } catch {}
            return null;
          })();

        await audit('logout', req, 200, userId);
        return reply.send({ ok: true, message: 'logout' });
      } catch (err: any) {
        req.log.error({ err }, 'auth/logout failed');
        return reply.code(400).send({ ok: false, message: err?.message ?? 'Error en logout' });
      }
    }
  );
}
