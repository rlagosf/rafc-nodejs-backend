import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { db } from '../db';

/**
 * Tabla: convocatorias_historico
 * Campos:
 *  id (PK AI),
 *  evento_id (FK),
 *  fecha_generacion (DATETIME/TIMESTAMP),
 *  listado_base64 (MEDIUMTEXT/LONGTEXT),
 *  generado_por (nullable)
 *
 * Notas de perf/seguridad:
 *  - Los listados generales NO devuelven listado_base64 (reduce payload).
 *  - Sanitizamos base64 si llega con prefijo data:...;base64,
 *  - Chequeo de tamaño aprox. en bytes para evitar abusos.
 */

// ---------- Schemas ----------
const CreateSchema = z.object({
  evento_id: z.number().int().positive(),
  // Si no viene, usamos NOW() en SQL:
  fecha_generacion: z.string().min(10).optional(),
  listado_base64: z.string().min(10),
});

const IdParam = z.object({ id: z.string().regex(/^\d+$/) });
const EventoParam = z.object({ evento_id: z.string().regex(/^\d+$/) });

// ---------- Utils ----------
const stripDataUrlPrefix = (s: string) => {
  // Acepta "data:application/pdf;base64,XXXXX" y devuelve solo "XXXXX"
  const idx = s.indexOf(',');
  if (s.startsWith('data:') && idx > -1) return s.slice(idx + 1);
  return s;
};

const approxBase64Bytes = (b64: string) => Math.floor((b64.length * 3) / 4); // aprox

// Límite configurable (coherente con app bodyLimit). 12 MB por defecto.
const MAX_BYTES = Number(process.env.CONVOC_HIST_MAX_BYTES || 12 * 1024 * 1024);

export default async function convocatorias_historico(app: FastifyInstance) {
  // Health
  app.get('/health', async () => ({
    module: 'convocatorias_historico',
    status: 'ready',
    timestamp: new Date().toISOString(),
  }));

  // Listar todo (SIN base64) – orden por fecha desc
  app.get('/', async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      const [rows]: any = await db.query(
        `SELECT id, evento_id, fecha_generacion, generado_por
           FROM convocatorias_historico
          ORDER BY fecha_generacion DESC, id DESC`
      );
      reply.send({ ok: true, items: rows });
    } catch (err: any) {
      reply.code(500).send({ ok: false, message: 'Error al listar histórico', error: err?.message });
    }
  });

  // Obtener por ID (INCLUYE base64)
  app.get('/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = IdParam.safeParse((req as any).params);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: 'ID inválido' });

    try {
      const id = Number(parsed.data.id);
      const [rows]: any = await db.query(
        `SELECT id, evento_id, fecha_generacion, listado_base64, generado_por
           FROM convocatorias_historico
          WHERE id = ? LIMIT 1`,
        [id]
      );
      if (!rows?.length) return reply.code(404).send({ ok: false, message: 'No encontrado' });
      reply.send({ ok: true, item: rows[0] });
    } catch (err: any) {
      reply.code(500).send({ ok: false, message: 'Error al obtener registro', error: err?.message });
    }
  });

  // Ver PDF por ID
  app.get('/ver/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = IdParam.safeParse((req as any).params);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: 'ID inválido' });

    try {
      const id = Number(parsed.data.id);
      const [rows]: any = await db.query(
        `SELECT listado_base64
           FROM convocatorias_historico
          WHERE id = ? LIMIT 1`,
        [id]
      );
      if (!rows?.length) return reply.code(404).send({ ok: false, message: 'No encontrado' });

      const base64: string = rows[0].listado_base64;
      const buf = Buffer.from(base64, 'base64');

      reply.header('Content-Type', 'application/pdf');
      reply.header('Content-Disposition', `inline; filename="convocatoria_${id}.pdf"`);
      return reply.send(buf);
    } catch (err: any) {
      reply.code(500).send({ ok: false, message: 'Error al generar PDF', error: err?.message });
    }
  });

  // Ver ÚLTIMO PDF por evento
  app.get('/ver/evento/:evento_id', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = EventoParam.safeParse((req as any).params);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: 'evento_id inválido' });

    try {
      const evento_id = Number(parsed.data.evento_id);
      const [rows]: any = await db.query(
        `SELECT id, listado_base64
           FROM convocatorias_historico
          WHERE evento_id = ?
          ORDER BY fecha_generacion DESC, id DESC
          LIMIT 1`,
        [evento_id]
      );
      if (!rows?.length) return reply.code(404).send({ ok: false, message: 'Sin histórico para el evento' });

      const { id, listado_base64 } = rows[0];
      const buf = Buffer.from(listado_base64, 'base64');

      reply.header('Content-Type', 'application/pdf');
      reply.header('Content-Disposition', `inline; filename="convocatoria_evento_${evento_id}_id_${id}.pdf"`);
      return reply.send(buf);
    } catch (err: any) {
      reply.code(500).send({ ok: false, message: 'Error al generar PDF por evento', error: err?.message });
    }
  });

  // Listar entradas por evento (SIN base64)
  app.get('/evento/:evento_id', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = EventoParam.safeParse((req as any).params);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: 'evento_id inválido' });

    try {
      const evento_id = Number(parsed.data.evento_id);
      const [rows]: any = await db.query(
        `SELECT id, evento_id, fecha_generacion, generado_por
           FROM convocatorias_historico
          WHERE evento_id = ?
          ORDER BY fecha_generacion DESC, id DESC`,
        [evento_id]
      );
      reply.send({ ok: true, items: rows });
    } catch (err: any) {
      reply.code(500).send({ ok: false, message: 'Error al listar por evento', error: err?.message });
    }
  });

  // Crear registro (fecha_generacion por defecto NOW() si no viene)
  app.post('/', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = CreateSchema.safeParse((req as any).body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, message: 'Payload inválido', errors: parsed.error.flatten() });
    }

    const { evento_id } = parsed.data;
    let { fecha_generacion, listado_base64 } = parsed.data;

    try {
      // Limpia prefijo data-url si viene
      listado_base64 = stripDataUrlPrefix(listado_base64);

      // Chequeo de tamaño (aprox real en bytes)
      const bytes = approxBase64Bytes(listado_base64);
      if (bytes > MAX_BYTES) {
        return reply.code(413).send({
          ok: false,
          message: `El PDF excede el límite permitido (${Math.floor(MAX_BYTES / (1024 * 1024))} MB).`,
        });
      }

      const sql = fecha_generacion
        ? `INSERT INTO convocatorias_historico (evento_id, fecha_generacion, listado_base64, generado_por)
           VALUES (?, ?, ?, NULL)`
        : `INSERT INTO convocatorias_historico (evento_id, fecha_generacion, listado_base64, generado_por)
           VALUES (?, NOW(), ?, NULL)`;

      const params = fecha_generacion
        ? [evento_id, fecha_generacion, listado_base64]
        : [evento_id, listado_base64];

      const [result]: any = await db.query(sql, params);

      reply.code(201).send({
        ok: true,
        id: result.insertId,
        evento_id,
        fecha_generacion: fecha_generacion ?? new Date().toISOString(),
        generado_por: null,
      });
    } catch (err: any) {
      reply.code(500).send({ ok: false, message: 'Error al crear registro', error: err?.message });
    }
  });

  // Eliminar registro
  app.delete('/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = IdParam.safeParse((req as any).params);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: 'ID inválido' });

    try {
      const id = Number(parsed.data.id);
      const [result]: any = await db.query('DELETE FROM convocatorias_historico WHERE id = ?', [id]);
      if (result.affectedRows === 0) return reply.code(404).send({ ok: false, message: 'No encontrado' });
      reply.send({ ok: true, deleted: id });
    } catch (err: any) {
      reply.code(500).send({ ok: false, message: 'Error al eliminar registro', error: err?.message });
    }
  });
}
