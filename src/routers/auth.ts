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

/* ───────────────────────── Helpers ───────────────────────── */

const ALLOWED_PANEL_ROLES = new Set([1, 2]); // 1=admin, 2=staff
const ACTIVE_ESTADO_ID = 1;

function getBearerToken(req: FastifyRequest) {
  const h = (req.headers.authorization || '').trim();
  const [type, token] = h.split(' ');
  if (type !== 'Bearer' || !token) return null;
  return token;
}

/**
 * ✅ requireAuth (mínimo) para /auth/logout:
 * - valida JWT
 * - valida usuario en BD (estado activo + rol permitido)
 * - setea req.user
 */
async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const token = getBearerToken(req);
  if (!token) {
    void audit('access_denied', req, 401, null, { reason: 'missing_token' });
    return reply.code(401).send({ ok: false, message: 'Token requerido' });
  }

  let decoded: any;
  try {
    decoded = jwt.verify(token, CONFIG.JWT_SECRET);
  } catch {
    void audit('invalid_token', req, 401, null, { reason: 'jwt_verify_failed' });
    return reply.code(401).send({ ok: false, message: 'Token inválido' });
  }

  const userId = Number(decoded?.sub);
  if (!Number.isFinite(userId) || userId <= 0) {
    void audit('invalid_token', req, 401, null, { reason: 'invalid_sub' });
    return reply.code(401).send({ ok: false, message: 'Token inválido' });
  }

  try {
    const [rows]: any = await db.query(
      `SELECT id, nombre_usuario, email, rol_id, estado_id
       FROM usuarios
       WHERE id = ?
       LIMIT 1`,
      [userId]
    );

    if (!rows?.length) {
      void audit('access_denied', req, 401, userId, { reason: 'user_not_found' });
      return reply.code(401).send({ ok: false, message: 'No autorizado' });
    }

    const user = rows[0];
    const rol = Number(user.rol_id);
    const estado = Number(user.estado_id);

    if (estado !== ACTIVE_ESTADO_ID) {
      void audit('access_denied', req, 403, user.id, { reason: 'user_inactive', estado_id: estado });
      return reply.code(403).send({ ok: false, message: 'Usuario inactivo' });
    }

    if (!ALLOWED_PANEL_ROLES.has(rol)) {
      void audit('access_denied', req, 403, user.id, { reason: 'role_not_allowed', rol_id: rol });
      return reply.code(403).send({ ok: false, message: 'No autorizado' });
    }

    (req as any).user = {
      id: user.id,
      nombre_usuario: user.nombre_usuario,
      email: user.email,
      rol_id: rol,
      estado_id: estado,
    };
  } catch (err: any) {
    req.log.error({ err }, 'requireAuth failed');
    void audit('access_denied', req, 500, userId, { reason: 'db_error', message: err?.message });
    return reply.code(500).send({ ok: false, message: 'Error de autenticación' });
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
        void audit('access_denied', req, 400, null, { reason: 'invalid_payload' });
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
        const rol = Number(user.rol_id);
        const estado = Number(user.estado_id);

        // ✅ 1) Estado activo obligatorio
        if (estado !== ACTIVE_ESTADO_ID) {
          void audit('access_denied', req, 403, user.id, {
            reason: 'user_inactive',
            estado_id: estado,
          });
          return reply.code(403).send({ ok: false, message: 'Usuario inactivo' });
        }

        // ✅ 2) Solo roles permitidos al panel (1 admin, 2 staff)
        if (!ALLOWED_PANEL_ROLES.has(rol)) {
          void audit('access_denied', req, 403, user.id, {
            reason: 'role_not_allowed',
            rol_id: rol,
          });
          return reply.code(403).send({ ok: false, message: 'No autorizado' });
        }

        const ok = await argon2Verify(user.password, password);
        if (!ok) {
          void audit('access_denied', req, 401, user.id, { reason: 'bad_password' });
          return reply.code(401).send({ ok: false, message: 'Credenciales inválidas' });
        }

        const payload = {
          sub: user.id,
          nombre_usuario: user.nombre_usuario,
          rol_id: rol,
        };

        const signOpts: SignOptions = {};
        if (CONFIG.JWT_EXPIRES_IN) {
          signOpts.expiresIn = CONFIG.JWT_EXPIRES_IN as unknown as jwt.SignOptions['expiresIn'];
        }

        const rafc_token = jwt.sign(payload, CONFIG.JWT_SECRET, signOpts);

        void audit('login', req, 200, user.id);

        return reply.send({
          ok: true,
          rafc_token,
          rol_id: rol,
          user: {
            id: user.id,
            nombre_usuario: user.nombre_usuario,
            email: user.email,
            rol_id: rol,
            estado_id: estado,
          },
        });
      } catch (err: any) {
        req.log.error({ err }, 'auth/login failed');
        void audit('access_denied', req, 500, null, {
          reason: 'exception',
          message: err?.message,
        });
        return reply.code(500).send({ ok: false, message: 'Error procesando login' });
      }
    }
  );

  /* ───────── POST /auth/logout ───────── */
  app.post('/logout', { preHandler: [requireAuth] }, async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = (req as any).user?.id ?? null;
    void audit('logout', req, 200, userId);
    return reply.send({ ok: true, message: 'logout' });
  });
}
