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

/**
 * Router default export (igual que los otros)
 * Se registra con prefix: /api/auth-apoderado
 */
export default async function auth_apoderado(
  app: FastifyInstance,
  _opts: FastifyPluginOptions
) {
  // POST /api/auth-apoderado/login  ✅ PUBLICO
  app.post("/login", async (req, reply) => {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, message: "BAD_REQUEST" });
    }

    const { rut, password } = parsed.data;
    const db = getDb();

    const [rows] = await db.query<any[]>(
      `SELECT rut_apoderado, password_hash, must_change_password
       FROM apoderados_auth
       WHERE rut_apoderado = ?
       LIMIT 1`,
      [rut]
    );

    if (!rows?.length) {
      return reply.code(401).send({ ok: false, message: "INVALID_CREDENTIALS" });
    }

    const auth = rows[0];

    const ok = await argon2.verify(auth.password_hash, password);
    if (!ok) {
      return reply.code(401).send({ ok: false, message: "INVALID_CREDENTIALS" });
    }

    const rafc_token = signApoderadoToken({ type: "apoderado", rut });

    await db.query(
      `UPDATE apoderados_auth SET last_login_at = NOW() WHERE rut_apoderado = ?`,
      [rut]
    );

    // ✅ IMPORTANTÍSIMO: devolver rafc_token (homologado con admin)
    return reply.send({
      ok: true,
      rafc_token,
      must_change_password: Number(auth.must_change_password) === 1,
    });
  });

  // GET /api/auth-apoderado/me  🔒 PROTEGIDO
  app.get("/me", async (req, reply) => {
    const tokenData = verifyApoderadoToken(req.headers.authorization);
    if (!tokenData) {
      return reply.code(401).send({ ok: false, message: "UNAUTHORIZED" });
    }

    const db = getDb();
    const [rows] = await db.query<any[]>(
      `SELECT rut_apoderado, must_change_password, last_login_at, created_at, updated_at
       FROM apoderados_auth
       WHERE rut_apoderado = ?
       LIMIT 1`,
      [tokenData.rut]
    );

    if (!rows?.length) {
      return reply.code(401).send({ ok: false, message: "UNAUTHORIZED" });
    }

    return reply.send({ ok: true, apoderado: rows[0] });
  });

  // POST /api/auth-apoderado/change-password  🔒 PROTEGIDO
  app.post("/change-password", async (req, reply) => {
    const tokenData = verifyApoderadoToken(req.headers.authorization);
    if (!tokenData) {
      return reply.code(401).send({ ok: false, message: "UNAUTHORIZED" });
    }

    const parsed = ChangePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, message: "BAD_REQUEST" });
    }

    const db = getDb();

    const [rows] = await db.query<any[]>(
      `SELECT password_hash
       FROM apoderados_auth
       WHERE rut_apoderado = ?
       LIMIT 1`,
      [tokenData.rut]
    );

    if (!rows?.length) {
      return reply.code(401).send({ ok: false, message: "UNAUTHORIZED" });
    }

    const ok = await argon2.verify(rows[0].password_hash, parsed.data.current_password);
    if (!ok) {
      return reply.code(401).send({ ok: false, message: "INVALID_CURRENT_PASSWORD" });
    }

    const newHash = await argon2.hash(parsed.data.new_password);

    await db.query(
      `UPDATE apoderados_auth
       SET password_hash = ?, must_change_password = 0, updated_at = NOW()
       WHERE rut_apoderado = ?`,
      [newHash, tokenData.rut]
    );

    return reply.send({ ok: true });
  });
}
