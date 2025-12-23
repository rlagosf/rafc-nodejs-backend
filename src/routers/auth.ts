// src/routers/auth.ts
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { verify as argon2Verify } from '@node-rs/argon2';
import jwt, { SignOptions } from 'jsonwebtoken';
import { db } from '../db';
import { CONFIG } from '../config';

/* ───────────────────────── Auditoría ───────────────────────── */

type AuditEvent =
  | 'login'
  | 'logout'
  | 'refresh'
  | 'invalid_token'
  | 'access_denied';

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
        ? req.headers['x-forwarded-for'][0]
        : (req.headers['x-forwarded-for'] as string)) || req.ip;

    const userAgent = (req.headers['user-agent'] as string) || null;
    const route = req.raw?.url || '';
    const method = req.method || 'GET';

    await db.query(
      `INSERT INTO auth_audit
       (user_id, event, route, method, status_code, ip, user_agent, extra)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId ?? null,
        event,
        route.substring(0, 255),
        method.substring(0, 10),
        status,
        ip?.toString().substring(0, 64),
        userAgent?.substring(0, 255),
        extra ? JSON.stringify(extra) : null,
      ]
    );
  } catch (e) {
    (req as any).log?.warn?.({ e }, 'auth_audit insert failed');
  }
}

/* ───────────────────────── Schemas ───────────────────────── */

const LoginSchema = z.object({
  nombre_usuario: z.string().min(3),
  password: z.string().min(4),
});

/* ───────────────────────── Router ───────────────────────── */

export default async function auth(app: FastifyInstance) {
  /* ───────── Health ───────── */
  app.get('/health', async () => ({
    module: 'auth',
    status: 'ready',
    timestamp: new Date().toISOString(),
  }));

  /* ───────── POST /auth/login ───────── */
  app.post(
    '/login',
    { schema: { security: [] } },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = LoginSchema.safeParse(req.body);
      if (!parsed.success) {
        void audit('access_denied', req, 400, null, {
          reason: 'invalid_payload',
        });
        return reply.code(400).send({ ok: false, message: 'Payload inválido' });
      }

      const { nombre_usuario, password } = parsed.data;

      try {
        const [rows]: any = await db.query(
          `SELECT id, nombre_usuario, email, password, rol_id, estado_id
           FROM usuarios
           WHERE nombre_usuario = BINARY ?
           LIMIT 1`,
          [nombre_usuario.trim()]
        );

        if (!rows.length) {
          void audit('access_denied', req, 401, null, {
            reason: 'user_not_found',
            nombre_usuario,
          });
          return reply.code(401).send({ ok: false, message: 'Credenciales inválidas' });
        }

        const user = rows[0];

        const ok = await argon2Verify(user.password, password);
        if (!ok) {
          void audit('access_denied', req, 401, user.id, {
            reason: 'bad_password',
          });
          return reply.code(401).send({ ok: false, message: 'Credenciales inválidas' });
        }

        const payload = {
          sub: user.id,
          nombre_usuario: user.nombre_usuario,
          rol_id: user.rol_id,
        };

        const signOpts: SignOptions = {};
        if (CONFIG.JWT_EXPIRES_IN) {
          signOpts.expiresIn =
            CONFIG.JWT_EXPIRES_IN as unknown as jwt.SignOptions['expiresIn'];
        }

        const rafc_token = jwt.sign(payload, CONFIG.JWT_SECRET, signOpts);

        // 🔥 auditoría NO bloqueante
        void audit('login', req, 200, user.id);

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
        void audit('access_denied', req, 500, null, {
          reason: 'exception',
          message: err?.message,
        });
        return reply.code(500).send({
          ok: false,
          message: 'Error procesando login',
        });
      }
    }
  );

  /* ───────── POST /auth/logout ───────── */
  app.post('/logout', async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = (req as any).user?.id ?? null;

    // 🔥 auditoría NO bloqueante
    void audit('logout', req, 200, userId);

    return reply.send({ ok: true, message: 'logout' });
  });
}
