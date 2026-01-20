// src/routers/auth_apoderado.ts
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import jwt from "jsonwebtoken";
import * as argon2 from "@node-rs/argon2";
import { z } from "zod";
import { getDb } from "../db";
import { CONFIG } from "../config";

const JWT_SECRET = CONFIG.JWT_SECRET;

const LoginSchema = z.object({
  rut: z.string().regex(/^\d{8}$/), // 8 dígitos, sin DV
  password: z.string().min(1),
});

const ChangePasswordSchema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(8),
});

type ApoderadoToken = { type: "apoderado"; rut: string };

/* ──────────────────────────────────────────────────────────────
   Token helpers
────────────────────────────────────────────────────────────── */
function signApoderadoToken(payload: ApoderadoToken) {
  if (!JWT_SECRET) throw new Error("JWT_SECRET missing");
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "12h" });
}

function verifyApoderadoToken(authHeader?: string): ApoderadoToken | null {
  if (!authHeader) return null;
  const [bearer, token] = authHeader.split(" ");
  if (bearer !== "Bearer" || !token) return null;

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    if (decoded?.type !== "apoderado") return null;

    const rut = String(decoded?.rut ?? "");
    if (!/^\d{8}$/.test(rut)) return null;

    return { type: "apoderado", rut };
  } catch {
    return null;
  }
}

function getTokenOr401(req: any, reply: any): ApoderadoToken | null {
  const tokenData = verifyApoderadoToken(req.headers.authorization);
  if (!tokenData) {
    reply.code(401).send({ ok: false, message: "UNAUTHORIZED" });
    return null;
  }
  return tokenData;
}

/* ──────────────────────────────────────────────────────────────
   Audit helpers (auth_audit)
   - Usa actor_type/actor_id (purista)
   - user_id queda NULL para apoderado
────────────────────────────────────────────────────────────── */
type AuditEvent = "login" | "logout" | "refresh" | "invalid_token" | "access_denied";

function getIp(req: any): string | null {
  const xff = req.headers?.["x-forwarded-for"];
  if (Array.isArray(xff)) return String(xff[0] || "").split(",")[0].trim() || null;
  if (typeof xff === "string" && xff) return xff.split(",")[0].trim() || null;

  const realIp = req.headers?.["x-real-ip"];
  if (typeof realIp === "string" && realIp) return realIp.trim();

  return req.ip ? String(req.ip) : null;
}

async function auditApoderado(params: {
  req: any;
  event: AuditEvent;
  statusCode: number;
  apoderadoId?: number | null;
  extra?: any;
}) {
  const { req, event, statusCode, apoderadoId = null, extra = null } = params;

  try {
    const db = getDb();

    const route =
      String(req.routerPath ?? req.raw?.url ?? req.url ?? "").slice(0, 255) || null;

    const method =
      String(req.method ?? req.raw?.method ?? "").slice(0, 10) || null;

    const ip = getIp(req);
    const ua =
      String(req.headers?.["user-agent"] ?? "").slice(0, 255) || null;

    await db.query(
      `
      INSERT INTO auth_audit
        (user_id, event, route, method, status_code, ip, user_agent, extra, actor_type, actor_id)
      VALUES
        (NULL, ?, ?, ?, ?, ?, ?, ?, 'apoderado', ?)
      `,
      [
        event,
        route,
        method,
        statusCode ?? null,
        ip,
        ua,
        extra ? JSON.stringify(extra) : null,
        apoderadoId,
      ]
    );
  } catch {
    // no reventamos el flujo por auditoría
  }
}

/* ──────────────────────────────────────────────────────────────
   Router (prefix: /api/auth-apoderado)
────────────────────────────────────────────────────────────── */
export default async function auth_apoderado(
  app: FastifyInstance,
  _opts: FastifyPluginOptions
) {
  /* ──────────────────────────────────────────────────────────────
     POST /api/auth-apoderado/login ✅ PUBLICO
     Devuelve: rafc_token (único token del sistema)
  ────────────────────────────────────────────────────────────── */
  app.post("/login", async (req, reply) => {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) {
      await auditApoderado({ req, event: "invalid_token", statusCode: 400, apoderadoId: null, extra: { where: "login", reason: "BAD_REQUEST" } });
      return reply.code(400).send({ ok: false, message: "BAD_REQUEST" });
    }

    const { rut, password } = parsed.data;
    const db = getDb();

    const [rows] = await db.query<any[]>(
      `SELECT apoderado_id, rut_apoderado, password_hash, must_change_password
         FROM apoderados_auth
        WHERE rut_apoderado = ?
        LIMIT 1`,
      [rut]
    );

    if (!rows?.length) {
      await auditApoderado({ req, event: "login", statusCode: 401, apoderadoId: null, extra: { rut, ok: false, reason: "NO_USER" } });
      return reply.code(401).send({ ok: false, message: "INVALID_CREDENTIALS" });
    }

    const auth = rows[0];
    const apoderadoId = Number(auth.apoderado_id) || null;

    const ok = await argon2.verify(auth.password_hash, password);
    if (!ok) {
      await auditApoderado({ req, event: "login", statusCode: 401, apoderadoId, extra: { rut, ok: false, reason: "BAD_PASSWORD" } });
      return reply.code(401).send({ ok: false, message: "INVALID_CREDENTIALS" });
    }

    const rafc_token = signApoderadoToken({ type: "apoderado", rut });

    await db.query(
      `UPDATE apoderados_auth
          SET last_login_at = NOW()
        WHERE apoderado_id = ?
        LIMIT 1`,
      [apoderadoId]
    );

    await auditApoderado({
      req,
      event: "login",
      statusCode: 200,
      apoderadoId,
      extra: { rut, ok: true, must_change_password: Number(auth.must_change_password) === 1 },
    });

    return reply.send({
      ok: true,
      rafc_token, // ✅ ÚNICO TOKEN
      must_change_password: Number(auth.must_change_password) === 1,
    });
  });

  /* ──────────────────────────────────────────────────────────────
     POST /api/auth-apoderado/logout 🔒 PROTEGIDO
     Registra auditoría (logout)
  ────────────────────────────────────────────────────────────── */
  app.post("/logout", async (req, reply) => {
    const tokenData = getTokenOr401(req, reply);
    if (!tokenData) {
      await auditApoderado({ req, event: "logout", statusCode: 401, apoderadoId: null, extra: { ok: false, reason: "UNAUTHORIZED" } });
      return;
    }

    const db = getDb();
    const [rows] = await db.query<any[]>(
      `SELECT apoderado_id
         FROM apoderados_auth
        WHERE rut_apoderado = ?
        LIMIT 1`,
      [tokenData.rut]
    );

    const apoderadoId = rows?.length ? Number(rows[0].apoderado_id) || null : null;

    await auditApoderado({
      req,
      event: "logout",
      statusCode: 200,
      apoderadoId,
      extra: { rut: tokenData.rut, ok: true },
    });

    return reply.send({ ok: true });
  });

  /* ──────────────────────────────────────────────────────────────
     GET /api/auth-apoderado/me 🔒 PROTEGIDO
  ────────────────────────────────────────────────────────────── */
  app.get("/me", async (req, reply) => {
    const tokenData = getTokenOr401(req, reply);
    if (!tokenData) {
      await auditApoderado({ req, event: "invalid_token", statusCode: 401, apoderadoId: null, extra: { where: "me" } });
      return;
    }

    const db = getDb();
    const [rows] = await db.query<any[]>(
      `SELECT apoderado_id, rut_apoderado, must_change_password, last_login_at, created_at, updated_at
         FROM apoderados_auth
        WHERE rut_apoderado = ?
        LIMIT 1`,
      [tokenData.rut]
    );

    if (!rows?.length) {
      await auditApoderado({ req, event: "invalid_token", statusCode: 401, apoderadoId: null, extra: { where: "me", reason: "NOT_FOUND" } });
      return reply.code(401).send({ ok: false, message: "UNAUTHORIZED" });
    }

    return reply.send({ ok: true, apoderado: rows[0] });
  });

  /* ──────────────────────────────────────────────────────────────
     POST /api/auth-apoderado/change-password 🔒 PROTEGIDO
  ────────────────────────────────────────────────────────────── */
  app.post("/change-password", async (req, reply) => {
    const tokenData = getTokenOr401(req, reply);
    if (!tokenData) {
      await auditApoderado({ req, event: "access_denied", statusCode: 401, apoderadoId: null, extra: { where: "change-password" } });
      return;
    }

    const parsed = ChangePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      await auditApoderado({ req, event: "access_denied", statusCode: 400, apoderadoId: null, extra: { where: "change-password", reason: "BAD_REQUEST" } });
      return reply.code(400).send({ ok: false, message: "BAD_REQUEST" });
    }

    const db = getDb();

    const [rows] = await db.query<any[]>(
      `SELECT apoderado_id, password_hash
         FROM apoderados_auth
        WHERE rut_apoderado = ?
        LIMIT 1`,
      [tokenData.rut]
    );

    if (!rows?.length) {
      await auditApoderado({ req, event: "access_denied", statusCode: 401, apoderadoId: null, extra: { where: "change-password", reason: "NOT_FOUND" } });
      return reply.code(401).send({ ok: false, message: "UNAUTHORIZED" });
    }

    const apoderadoId = Number(rows[0].apoderado_id) || null;

    const ok = await argon2.verify(rows[0].password_hash, parsed.data.current_password);
    if (!ok) {
      await auditApoderado({ req, event: "access_denied", statusCode: 401, apoderadoId, extra: { where: "change-password", reason: "INVALID_CURRENT_PASSWORD" } });
      return reply.code(401).send({ ok: false, message: "INVALID_CURRENT_PASSWORD" });
    }

    const newHash = await argon2.hash(parsed.data.new_password);

    await db.query(
      `UPDATE apoderados_auth
          SET password_hash = ?,
              must_change_password = 0,
              updated_at = NOW()
        WHERE apoderado_id = ?
        LIMIT 1`,
      [newHash, apoderadoId]
    );

    await auditApoderado({ req, event: "refresh", statusCode: 200, apoderadoId, extra: { where: "change-password", ok: true } });

    return reply.send({ ok: true });
  });
}
