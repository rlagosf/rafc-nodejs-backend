import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { getDb } from "../db";

const JWT_SECRET = process.env.JWT_SECRET as string;

type ApoderadoToken = { type: "apoderado"; rut: string };

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

async function requireApoderadoPortalOk(rut: string) {
  const db = getDb();
  const [rows] = await db.query<any[]>(
    `SELECT must_change_password
     FROM apoderados_auth
     WHERE rut_apoderado = ?
     LIMIT 1`,
    [rut]
  );

  if (!rows?.length) return { ok: false as const, code: 401, message: "UNAUTHORIZED" };
  if (Number(rows[0].must_change_password) === 1) {
    return { ok: false as const, code: 403, message: "PASSWORD_CHANGE_REQUIRED" };
  }
  return { ok: true as const };
}

const RutJugadorParam = z.object({ rut: z.string().regex(/^\d{8}$/) });

export default async function portal_apoderado(
  app: FastifyInstance,
  _opts: FastifyPluginOptions
) {
  // GET /api/portal-apoderado/mis-jugadores
  app.get("/mis-jugadores", async (req, reply) => {
    const tokenData = verifyApoderadoToken(req.headers.authorization);
    if (!tokenData) {
      return reply.code(401).send({ ok: false, message: "UNAUTHORIZED" });
    }

    const guard = await requireApoderadoPortalOk(tokenData.rut);
    if (!guard.ok) {
      return reply.code(guard.code).send({ ok: false, message: guard.message });
    }

    const db = getDb();
    const [rows] = await db.query<any[]>(
      `SELECT rut_jugador, nombres, apellidos
       FROM jugadores
       WHERE rut_apoderado = ?
       ORDER BY apellidos, nombres`,
      [tokenData.rut]
    );

    return reply.send({ ok: true, jugadores: rows });
  });

  // GET /api/portal-apoderado/jugadores/:rut/pagos
  app.get("/jugadores/:rut/pagos", async (req, reply) => {
    const tokenData = verifyApoderadoToken(req.headers.authorization);
    if (!tokenData) {
      return reply.code(401).send({ ok: false, message: "UNAUTHORIZED" });
    }

    const guard = await requireApoderadoPortalOk(tokenData.rut);
    if (!guard.ok) {
      return reply.code(guard.code).send({ ok: false, message: guard.message });
    }

    const parsed = RutJugadorParam.safeParse(req.params);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, message: "BAD_REQUEST" });
    }

    const rutJugador = parsed.data.rut;
    const db = getDb();

    // valida pertenencia
    const [own] = await db.query<any[]>(
      `SELECT 1
       FROM jugadores
       WHERE rut_jugador = ? AND rut_apoderado = ?
       LIMIT 1`,
      [rutJugador, tokenData.rut]
    );
    if (!own?.length) {
      return reply.code(403).send({ ok: false, message: "FORBIDDEN" });
    }

    const [pagos] = await db.query<any[]>(
      `SELECT *
       FROM pagos_jugador
       WHERE jugador_rut = ?
       ORDER BY fecha_pago DESC`,
      [rutJugador]
    );

    return reply.send({ ok: true, pagos });
  });
}
