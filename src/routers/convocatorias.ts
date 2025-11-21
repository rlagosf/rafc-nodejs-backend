import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { db } from '../db';

// Helpers
const b2i = (v: boolean | number | undefined | null) => (v ? 1 : 0);
const i2b = (v: any) => (v ? true : false);

// Validadores
const ConvocatoriaSchema = z.object({
  jugador_rut: z.number().int().positive(),
  fecha_partido: z.string().refine(x => !isNaN(Date.parse(x)), "fecha_partido inválida"),
  evento_id: z.number().int().positive(),
  asistio: z.boolean().optional().default(false),
  titular: z.boolean().optional().default(false),
  observaciones: z.string().nullable().optional(),
});

const OneOrManySchema = z.union([
  ConvocatoriaSchema,
  z.array(ConvocatoriaSchema).min(1)
]);

const IdParam = z.object({ id: z.string().regex(/^\d+$/) });
const EventoParam = z.object({ evento_id: z.string().regex(/^\d+$/) });

const ConvocatoriaParam = z.object({
  evento_id: z.string().regex(/^\d+$/),
  convocatoria_id: z.string().regex(/^\d+$/),
});

const PaginationQuery = z.object({
  page: z.string().regex(/^\d+$/).optional(),
  pageSize: z.string().regex(/^\d+$/).optional(),
});

export default async function convocatorias(app: FastifyInstance) {

  // ================= HEALTH =================
  app.get('/health', async () => ({
    module: 'convocatorias',
    status: 'ready',
    timestamp: new Date().toISOString()
  }));

  // ================= GET TODOS =================
  app.get('/', async (req, reply) => {
    try {
      const parsed = PaginationQuery.safeParse(req.query);
      const page = parsed.success && parsed.data.page ? Number(parsed.data.page) : 1;
      const pageSize = parsed.success && parsed.data.pageSize
        ? Math.min(Number(parsed.data.pageSize), 200)
        : 50;

      const offset = (page - 1) * pageSize;

      const [rows] = await db.query(
        `SELECT id, jugador_rut, fecha_partido, evento_id, convocatoria_id, asistio, titular, observaciones
           FROM convocatorias
          ORDER BY fecha_partido DESC, id DESC
          LIMIT ? OFFSET ?`,
        [pageSize, offset]
      );

      const items = (rows as any[]).map(r => ({
        ...r,
        asistio: i2b(r.asistio),
        titular: i2b(r.titular),
      }));

      return reply.send({ ok: true, items, page, pageSize });
    } catch {
      return reply.code(500).send({ ok: false, message: 'Error al listar convocatorias' });
    }
  });

  // ================= GET POR EVENTO =================
  app.get('/evento/:evento_id', async (req, reply) => {
    const parsedParam = EventoParam.safeParse(req.params);
    if (!parsedParam.success)
      return reply.code(400).send({ ok: false, message: 'evento_id inválido' });

    const parsedQuery = PaginationQuery.safeParse(req.query);
    const page = parsedQuery.success && parsedQuery.data.page ? Number(parsedQuery.data.page) : 1;
    const pageSize = parsedQuery.success && parsedQuery.data.pageSize
      ? Math.min(Number(parsedQuery.data.pageSize), 200)
      : 50;

    const offset = (page - 1) * pageSize;
    const evento_id = Number(parsedParam.data.evento_id);

    try {
      const [rows] = await db.query(
        `SELECT id, jugador_rut, fecha_partido, evento_id, convocatoria_id, asistio, titular, observaciones
           FROM convocatorias
          WHERE evento_id = ?
          ORDER BY fecha_partido DESC, id DESC
          LIMIT ? OFFSET ?`,
        [evento_id, pageSize, offset]
      );

      const items = (rows as any[]).map(r => ({
        ...r,
        asistio: i2b(r.asistio),
        titular: i2b(r.titular),
      }));

      return reply.send({ ok: true, items, page, pageSize });

    } catch {
      return reply.code(500).send({ ok: false, message: 'Error al listar por evento' });
    }
  });

  // ================= GET por evento + convocatoria_id =================
  app.get(
    '/evento/:evento_id/convocatoria/:convocatoria_id',
    async (req, reply) => {
      const parsed = ConvocatoriaParam.safeParse(req.params);
      if (!parsed.success) {
        return reply.code(400).send({ ok: false, message: 'Parámetros inválidos' });
      }

      const evento_id = Number(parsed.data.evento_id);
      const convocatoria_id = Number(parsed.data.convocatoria_id);

      try {
        const [rows]: any = await db.query(
          `SELECT id, jugador_rut, fecha_partido, evento_id, convocatoria_id, asistio, titular, observaciones
             FROM convocatorias
            WHERE evento_id = ? AND convocatoria_id = ?
            ORDER BY jugador_rut ASC`,
          [evento_id, convocatoria_id]
        );

        const items = rows.map((r: any) => ({
          ...r,
          asistio: i2b(r.asistio),
          titular: i2b(r.titular),
        }));

        return reply.send({ ok: true, items });
      } catch {
        return reply.code(500).send({ ok: false, message: 'Error al obtener jugadores de la convocatoria' });
      }
    }
  );

  // ================= GET por ID =================
  app.get('/:id', async (req, reply) => {
    const parsed = IdParam.safeParse(req.params);
    if (!parsed.success)
      return reply.code(400).send({ ok: false, message: 'ID inválido' });

    try {
      const id = Number(parsed.data.id);
      const [rows]: any = await db.query(
        `SELECT id, jugador_rut, fecha_partido, evento_id, convocatoria_id, asistio, titular, observaciones
           FROM convocatorias WHERE id = ? LIMIT 1`,
        [id]
      );

      if (!rows.length)
        return reply.code(404).send({ ok: false, message: 'No encontrado' });

      const r = rows[0];

      return reply.send({
        ok: true,
        item: {
          ...r,
          asistio: i2b(r.asistio),
          titular: i2b(r.titular),
        },
      });
    } catch {
      return reply.code(500).send({ ok: false, message: 'Error al obtener convocatoria' });
    }
  });

  // ================= POST CON convocatoria_id =================
  app.post('/', async (req, reply) => {
    // Validar tamaño
    const sizeBytes = Buffer.byteLength(JSON.stringify(req.body));
    if (sizeBytes > 1024 * 1024) {
      return reply.code(413).send({
        ok: false,
        message: 'Payload demasiado grande (máx 1 MB)'
      });
    }

    const parsed = OneOrManySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        message: 'Payload inválido',
        errors: parsed.error.flatten()
      });
    }

    const data = Array.isArray(parsed.data) ? parsed.data : [parsed.data];

    if (data.length > 100) {
      return reply.code(413).send({
        ok: false,
        message: `Se envió un listado demasiado grande (${data.length}). Máximo = 100.`,
      });
    }

    // ============ VALIDAR QUE TODOS SEAN DEL MISMO EVENTO ============
    const eventoIds = Array.from(new Set(data.map(d => d.evento_id)));
    if (eventoIds.length !== 1) {
      return reply.code(400).send({
        ok: false,
        message: 'Todos los registros deben tener el mismo evento_id'
      });
    }

    const evento_id = eventoIds[0];

    try {
      // 1️⃣ Obtener el último convocatoria_id para ese evento
      const [rowsMax]: any = await db.query(
        'SELECT COALESCE(MAX(convocatoria_id), 0) AS maxConv FROM convocatorias WHERE evento_id = ?',
        [evento_id]
      );

      const nextConvId = (rowsMax?.[0]?.maxConv || 0) + 1;

      // 2️⃣ Preparar valores
      const values = data.map(d => [
        d.jugador_rut,
        d.fecha_partido,
        d.evento_id,
        nextConvId,      // ← NUEVO
        b2i(d.asistio),
        b2i(d.titular),
        d.observaciones ?? null,
      ]);

      // 3️⃣ Insertar
      const sql = `
        INSERT INTO convocatorias
          (jugador_rut, fecha_partido, evento_id, convocatoria_id, asistio, titular, observaciones)
        VALUES ?
      `;

      const [result]: any = await db.query(sql, [values]);

      // 4️⃣ Respuesta
      return reply.code(201).send({
        ok: true,
        evento_id,
        convocatoria_id: nextConvId,
        inserted: values.length
      });

    } catch (err: any) {
      return reply.code(500).send({
        ok: false,
        message: 'Error al crear convocatoria(s)',
        error: err?.message
      });
    }
  });

  // ================= PUT =================
  app.put('/:id', async (req, reply) => {
    const idParsed = IdParam.safeParse(req.params);
    if (!idParsed.success)
      return reply.code(400).send({ ok: false, message: 'ID inválido' });

    const bodyParsed = ConvocatoriaSchema.partial().safeParse(req.body);
    if (!bodyParsed.success)
      return reply.code(400).send({ ok: false, message: 'Payload inválido' });

    const data = bodyParsed.data;
    const fields: string[] = [];
    const values: any[] = [];

    if (data.jugador_rut !== undefined) { fields.push('jugador_rut = ?'); values.push(data.jugador_rut); }
    if (data.fecha_partido !== undefined) { fields.push('fecha_partido = ?'); values.push(data.fecha_partido); }
    if (data.evento_id !== undefined) { fields.push('evento_id = ?'); values.push(data.evento_id); }
    if (data.asistio !== undefined) { fields.push('asistio = ?'); values.push(b2i(data.asistio)); }
    if (data.titular !== undefined) { fields.push('titular = ?'); values.push(b2i(data.titular)); }
    if (data.observaciones !== undefined) { fields.push('observaciones = ?'); values.push(data.observaciones ?? null); }

    if (fields.length === 0)
      return reply.code(400).send({ ok: false, message: 'No hay campos para actualizar' });

    try {
      const [result]: any = await db.query(
        `UPDATE convocatorias SET ${fields.join(', ')} WHERE id = ?`,
        [...values, Number(idParsed.data.id)]
      );

      if (result.affectedRows === 0)
        return reply.code(404).send({ ok: false, message: 'No encontrado' });

      return reply.send({ ok: true, updated: { ...data } });

    } catch {
      return reply.code(500).send({ ok: false, message: 'Error al actualizar' });
    }
  });

  // ================= DELETE =================
  app.delete('/:id', async (req, reply) => {
    const parsed = IdParam.safeParse(req.params);
    if (!parsed.success)
      return reply.code(400).send({ ok: false, message: 'ID inválido' });

    try {
      const [result]: any = await db.query(
        'DELETE FROM convocatorias WHERE id = ?',
        [Number(parsed.data.id)]
      );

      if (result.affectedRows === 0)
        return reply.code(404).send({ ok: false, message: 'No encontrado' });

      return reply.send({ ok: true, deleted: Number(parsed.data.id) });

    } catch {
      return reply.code(500).send({ ok: false, message: 'Error al eliminar' });
    }
  });

}
