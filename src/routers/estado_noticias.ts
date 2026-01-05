import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { getDb } from "../db";

// ⚠️ Reemplaza por tu guard real si quieres que sea admin-only
async function requireAdmin(_req: any, reply: any) {
  // if (!authorized) return reply.code(401).send({ ok:false, message:"UNAUTHORIZED" });
  return true;
}

export default async function estado_noticias(
  app: FastifyInstance,
  _opts: FastifyPluginOptions
) {
  /**
   * GET /api/estado-noticias
   * Catálogo liviano: id + nombre
   */
  app.get("/", async (req, reply) => {
    await requireAdmin(req, reply);

    const db = getDb();
    const [rows] = await db.query<any[]>(
      `
      SELECT id, nombre
      FROM estado_noticias
      ORDER BY id ASC
      `
    );

    return reply.send({ ok: true, items: rows ?? [] });
  });
}
