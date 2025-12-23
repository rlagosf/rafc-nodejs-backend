// src/routers/contratos_jugadores.ts
import { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../db";

/* ───────────────────────────────
   ZOD SCHEMAS
─────────────────────────────── */

const CreateSchema = z.object({
  rut_jugador: z.coerce.number().int().positive(),
  rut_apoderado: z.coerce.number().int().positive(),
  fecha_generacion: z.string().optional(),
  contrato_base64: z.string().min(10),
});

const IdParam = z.object({
  id: z.string().regex(/^\d+$/),
});

const RutParam = z.object({
  rut: z.string().regex(/^\d{7,8}$/),
});

const PaginationQuery = z.object({
  page: z.string().regex(/^\d+$/).optional(),
  pageSize: z.string().regex(/^\d+$/).optional(),
});

/* ───────────────────────────────
   UTILS
─────────────────────────────── */

const stripDataUrlPrefix = (s: string) => {
  const idx = s.indexOf(",");
  return s.startsWith("data:") && idx > -1 ? s.slice(idx + 1) : s;
};

const approxBytes = (b64: string) => Math.floor((b64.length * 3) / 4);

// Ajustable por env
const MAX_BYTES = Number(process.env.CONTRATOS_MAX_BYTES || 12 * 1024 * 1024);

const toMySQLDateTimeOrNull = (iso?: string) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace("T", " ");
};

/* ───────────────────────────────
   ROUTER
─────────────────────────────── */

export default async function contratos_jugadores(app: FastifyInstance) {
  // Health
  app.get("/health", async () => ({
    module: "contratos_jugadores",
    status: "ready",
    timestamp: new Date().toISOString(),
  }));

  // LISTAR (paginado)
  app.get("/", async (req, reply) => {
    try {
      const parsed = PaginationQuery.safeParse((req as any).query);
      const page = parsed.success && parsed.data.page ? Number(parsed.data.page) : 1;
      const size = parsed.success && parsed.data.pageSize ? Number(parsed.data.pageSize) : 50;

      const limit = Math.min(Math.max(size, 1), 200);
      const offset = (Math.max(page, 1) - 1) * limit;

      const [rows]: any = await db.query(
        `SELECT id, rut_jugador, rut_apoderado, fecha_generacion
           FROM contratos_jugadores
          ORDER BY fecha_generacion DESC, id DESC
          LIMIT ? OFFSET ?`,
        [limit, offset]
      );

      reply.send({ ok: true, items: rows ?? [], page, pageSize: limit });
    } catch (e: any) {
      reply.code(500).send({ ok: false, message: "Error al listar", error: e?.message });
    }
  });

  // OBTENER POR ID
  app.get("/:id", async (req, reply) => {
    const p = IdParam.safeParse((req as any).params);
    if (!p.success) return reply.code(400).send({ ok: false, message: "ID inválido" });

    try {
      const id = Number(p.data.id);

      const [rows]: any = await db.query(
        `SELECT id, rut_jugador, rut_apoderado, fecha_generacion, contrato_base64
           FROM contratos_jugadores
          WHERE id = ?
          LIMIT 1`,
        [id]
      );

      if (!rows?.length) return reply.code(404).send({ ok: false, message: "No encontrado" });

      reply.send({ ok: true, item: rows[0] });
    } catch (e: any) {
      reply.code(500).send({ ok: false, message: "Error al obtener registro", error: e?.message });
    }
  });

  // LISTAR POR rut_jugador
  app.get("/jugador/:rut", async (req, reply) => {
    const p = RutParam.safeParse((req as any).params);
    if (!p.success) return reply.code(400).send({ ok: false, message: "RUT inválido" });

    try {
      const rut = Number(p.data.rut);

      const [rows]: any = await db.query(
        `SELECT id, rut_jugador, rut_apoderado, fecha_generacion
           FROM contratos_jugadores
          WHERE rut_jugador = ?
          ORDER BY fecha_generacion DESC, id DESC`,
        [rut]
      );

      reply.send({ ok: true, items: rows ?? [] });
    } catch (e: any) {
      reply.code(500).send({ ok: false, message: "Error al listar por jugador", error: e?.message });
    }
  });

  // (Opcional) LISTAR POR rut_apoderado
  app.get("/apoderado/:rut", async (req, reply) => {
    const p = RutParam.safeParse((req as any).params);
    if (!p.success) return reply.code(400).send({ ok: false, message: "RUT inválido" });

    try {
      const rut = Number(p.data.rut);

      const [rows]: any = await db.query(
        `SELECT id, rut_jugador, rut_apoderado, fecha_generacion
           FROM contratos_jugadores
          WHERE rut_apoderado = ?
          ORDER BY fecha_generacion DESC, id DESC`,
        [rut]
      );

      reply.send({ ok: true, items: rows ?? [] });
    } catch (e: any) {
      reply.code(500).send({ ok: false, message: "Error al listar por apoderado", error: e?.message });
    }
  });

  // VER PDF INLINE
  app.get("/ver/:id", async (req, reply) => {
    const p = IdParam.safeParse((req as any).params);
    if (!p.success) return reply.code(400).send({ ok: false, message: "ID inválido" });

    try {
      const id = Number(p.data.id);

      const [rows]: any = await db.query(
        `SELECT contrato_base64
           FROM contratos_jugadores
          WHERE id = ?
          LIMIT 1`,
        [id]
      );

      if (!rows?.length) return reply.code(404).send({ ok: false, message: "No encontrado" });

      const pure = stripDataUrlPrefix(String(rows[0].contrato_base64 || ""));
      const buf = Buffer.from(pure, "base64");

      reply.header("Content-Type", "application/pdf");
      reply.header("Content-Disposition", `inline; filename="contrato_${id}.pdf"`);
      return reply.send(buf);
    } catch (e: any) {
      reply.code(500).send({ ok: false, message: "Error al generar PDF", error: e?.message });
    }
  });

  // CREAR
  app.post("/", async (req, reply) => {
    const parsed = CreateSchema.safeParse((req as any).body);
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        message: "Payload inválido",
        errors: parsed.error.flatten(),
      });
    }

    const { rut_jugador, rut_apoderado } = parsed.data;
    const pure = stripDataUrlPrefix(parsed.data.contrato_base64);
    const bytes = approxBytes(pure);

    if (bytes > MAX_BYTES) {
      return reply.code(413).send({
        ok: false,
        message: `El PDF excede el límite permitido (${Math.floor(MAX_BYTES / (1024 * 1024))} MB).`,
      });
    }

    const fechaMySQL = toMySQLDateTimeOrNull(parsed.data.fecha_generacion);

    try {
      // ✅ Checks FK “amables” (opcional pero recomendado)
      // Si tus FKs ya están bien, esto te evita 500 feos y te da 409 con field claro.
      const [[jug]]: any = await db.query(
        `SELECT 1 FROM jugadores WHERE rut_jugador = ? LIMIT 1`,
        [rut_jugador]
      );
      if (!jug) {
        return reply.code(409).send({
          ok: false,
          field: "rut_jugador",
          message: "Violación de clave foránea: rut_jugador no existe",
        });
      }

      const [[apo]]: any = await db.query(
        `SELECT 1 FROM jugadores WHERE rut_jugador = ? LIMIT 1`,
        [rut_apoderado]
      );
      if (!apo) {
        return reply.code(409).send({
          ok: false,
          field: "rut_apoderado",
          message: "Violación de clave foránea: rut_apoderado no existe",
        });
      }

      const sql = `
        INSERT INTO contratos_jugadores
          (rut_jugador, rut_apoderado, fecha_generacion, contrato_base64)
        VALUES (?, ?, ${fechaMySQL ? "?" : "NOW()"}, ?)
      `;

      const params = fechaMySQL
        ? [rut_jugador, rut_apoderado, fechaMySQL, pure]
        : [rut_jugador, rut_apoderado, pure];

      const [result]: any = await db.query(sql, params);

      reply.code(201).send({
        ok: true,
        id: result.insertId,
        rut_jugador,
        rut_apoderado,
        fecha_generacion: fechaMySQL ?? new Date().toISOString(),
      });
    } catch (e: any) {
      // Si igual te llega error FK desde MySQL:
      if (e?.errno === 1452) {
        return reply.code(409).send({
          ok: false,
          message: "Violación de clave foránea (revisa ruts enviados)",
          detail: e?.sqlMessage ?? e?.message,
        });
      }

      reply.code(500).send({
        ok: false,
        message: "Error al crear contrato",
        error: e?.message,
      });
    }
  });
}
