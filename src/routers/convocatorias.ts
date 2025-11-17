import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { db } from '../db';

/**
 * Tabla: convocatorias
 * Campos (sugeridos):
 *  - id (PK autoincrement)
 *  - jugador_rut (INT/BIGINT)            <-- numérico
 *  - fecha_partido (DATE)                <-- 'YYYY-MM-DD'
 *  - evento_id (INT, FK)
 *  - asistio (TINYINT(1) -> 0/1)         <-- boolean API
 *  - titular (TINYINT(1) -> 0/1)         <-- boolean API
 *  - observaciones (TEXT NULL)
 *  - created_at (DATETIME default now)   (opcional)
 */

const b2i = (v: boolean | number | undefined | null) => (v ? 1 : 0);
const i2b = (v: any) => (v ? true : false);

// Zod schemas (RUT NUMÉRICO)
const ConvocatoriaSchema = z.object({
  jugador_rut: z.number().int().positive(),
  fecha_partido: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'fecha_partido debe ser YYYY-MM-DD'),
  evento_id: z.number().int().positive(),
  asistio: z.boolean().optional().default(false),
  titular: z.boolean().optional().default(false),
  observaciones: z.string().nullable().optional()
});

const OneOrManySchema = z.union([ConvocatoriaSchema, z.array(ConvocatoriaSchema).min(1)]);

const IdParam = z.object({ id: z.string().regex(/^\d+$/) });
const EventoParam = z.object({ evento_id: z.string().regex(/^\d+$/) });

export default async function convocatorias(app: FastifyInstance) {
  // Health del módulo
  app.get('/health', async () => ({
    module: 'convocatorias',
    status: 'ready',
    timestamp: new Date().toISOString()
  }));

  // Listar todas
  app.get('/', async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      const [rows]: any = await db.query(
        'SELECT id, jugador_rut, fecha_partido, evento_id, asistio, titular, observaciones FROM convocatorias ORDER BY fecha_partido DESC, id DESC'
      );
      const items = rows.map((r: any) => ({
        ...r,
        asistio: i2b(r.asistio),
        titular: i2b(r.titular)
      }));
      reply.send({ ok: true, items });
    } catch (err: any) {
      reply.code(500).send({ ok: false, message: 'Error al listar convocatorias', error: err?.message });
    }
  });

  // Listar por evento_id
  app.get('/evento/:evento_id', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = EventoParam.safeParse((req as any).params);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: 'evento_id inválido' });
    const evento_id = Number(parsed.data.evento_id);

    try {
      const [rows]: any = await db.query(
        'SELECT id, jugador_rut, fecha_partido, evento_id, asistio, titular, observaciones FROM convocatorias WHERE evento_id = ? ORDER BY fecha_partido DESC, id DESC',
        [evento_id]
      );
      const items = rows.map((r: any) => ({
        ...r,
        asistio: i2b(r.asistio),
        titular: i2b(r.titular)
      }));
      reply.send({ ok: true, items });
    } catch (err: any) {
      reply.code(500).send({ ok: false, message: 'Error al listar por evento', error: err?.message });
    }
  });

  // Obtener por ID
  app.get('/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = IdParam.safeParse((req as any).params);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: 'ID inválido' });
    const id = Number(parsed.data.id);

    try {
      const [rows]: any = await db.query(
        'SELECT id, jugador_rut, fecha_partido, evento_id, asistio, titular, observaciones FROM convocatorias WHERE id = ? LIMIT 1',
        [id]
      );
      if (!rows || rows.length === 0) return reply.code(404).send({ ok: false, message: 'No encontrado' });

      const r = rows[0];
      reply.send({
        ok: true,
        item: {
          ...r,
          asistio: i2b(r.asistio),
          titular: i2b(r.titular)
        }
      });
    } catch (err: any) {
      reply.code(500).send({ ok: false, message: 'Error al obtener convocatoria', error: err?.message });
    }
  });

  // Crear 1 o muchas (auto-detección)
  app.post('/', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = OneOrManySchema.safeParse((req as any).body);
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        message: 'Payload inválido',
        detail: 'Revisa tipos y nombres de campos',
        errors: parsed.error.flatten()
      });
    }

    const data = Array.isArray(parsed.data) ? parsed.data : [parsed.data];
    const values = data.map(d => [
      d.jugador_rut,
      d.fecha_partido,
      d.evento_id,
      b2i(d.asistio),
      b2i(d.titular),
      d.observaciones ?? null
    ]);

    try {
      const sql = `
        INSERT INTO convocatorias
          (jugador_rut, fecha_partido, evento_id, asistio, titular, observaciones)
        VALUES ?
      `;
      const [result]: any = await db.query(sql, [values]);

      if (values.length === 1) {
        return reply.code(201).send({ ok: true, id: result.insertId, ...data[0] });
      }
      return reply.code(201).send({ ok: true, inserted: values.length, firstId: result.insertId });
    } catch (err: any) {
      return reply.code(500).send({
        ok: false,
        message: 'Error al crear convocatoria(s)',
        error: err?.message
      });
    }
  });

  // Alias explícito para arreglos
  app.post('/bulk', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = z.array(ConvocatoriaSchema).min(1).safeParse((req as any).body);
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        message: 'Payload inválido',
        detail: 'Se espera un arreglo de convocatorias',
        errors: parsed.error.flatten()
      });
    }
    const arr = parsed.data;
    const values = arr.map(d => [
      d.jugador_rut,
      d.fecha_partido,
      d.evento_id,
      b2i(d.asistio),
      b2i(d.titular),
      d.observaciones ?? null
    ]);
    try {
      const sql = `
        INSERT INTO convocatorias
          (jugador_rut, fecha_partido, evento_id, asistio, titular, observaciones)
        VALUES ?
      `;
      const [result]: any = await db.query(sql, [values]);
      return reply.code(201).send({ ok: true, inserted: values.length, firstId: result.insertId });
    } catch (err: any) {
      return reply.code(500).send({ ok: false, message: 'Error al crear convocatoria(s)', error: err?.message });
    }
  });

  // Actualizar (parcial)
  app.put('/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const idParsed = IdParam.safeParse((req as any).params);
    if (!idParsed.success) return reply.code(400).send({ ok: false, message: 'ID inválido' });
    const id = Number(idParsed.data.id);

    const bodyParsed = ConvocatoriaSchema.partial().safeParse((req as any).body);
    if (!bodyParsed.success) {
      return reply.code(400).send({ ok: false, message: 'Payload inválido', errors: bodyParsed.error.flatten() });
    }
    const data = bodyParsed.data;

    const fields: string[] = [];
    const values: any[] = [];
    if (data.jugador_rut !== undefined) { fields.push('jugador_rut = ?'); values.push(data.jugador_rut); }
    if (data.fecha_partido !== undefined) { fields.push('fecha_partido = ?'); values.push(data.fecha_partido); }
    if (data.evento_id !== undefined) { fields.push('evento_id = ?'); values.push(data.evento_id); }
    if (data.asistio !== undefined) { fields.push('asistio = ?'); values.push(b2i(data.asistio)); }
    if (data.titular !== undefined) { fields.push('titular = ?'); values.push(b2i(data.titular)); }
    if (data.observaciones !== undefined) { fields.push('observaciones = ?'); values.push(data.observaciones ?? null); }

    if (fields.length === 0) {
      return reply.code(400).send({ ok: false, message: 'No hay campos para actualizar' });
    }

    try {
      const [result]: any = await db.query(`UPDATE convocatorias SET ${fields.join(', ')} WHERE id = ?`, [...values, id]);
      if (result.affectedRows === 0) return reply.code(404).send({ ok: false, message: 'No encontrado' });
      reply.send({ ok: true, updated: { id, ...data } });
    } catch (err: any) {
      reply.code(500).send({ ok: false, message: 'Error al actualizar', error: err?.message });
    }
  });

  // Eliminar
  app.delete('/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = IdParam.safeParse((req as any).params);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: 'ID inválido' });

    const id = Number(parsed.data.id);
    try {
      const [result]: any = await db.query('DELETE FROM convocatorias WHERE id = ?', [id]);
      if (result.affectedRows === 0) return reply.code(404).send({ ok: false, message: 'No encontrado' });
      reply.send({ ok: true, deleted: id });
    } catch (err: any) {
      reply.code(500).send({ ok: false, message: 'Error al eliminar', error: err?.message });
    }
  });
}
