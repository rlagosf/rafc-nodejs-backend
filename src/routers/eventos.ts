import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { db } from '../db';

/**
 * Tabla: eventos
 *  id, titulo, descripcion, fecha_inicio, fecha_fin, creado_en, actualizado_en
 * Notas:
 *  - creado_en / actualizado_en vía NOW().
 *  - Aceptamos ISO o 'YYYY-MM-DD HH:MM:SS' y los normalizamos a formato SQL.
 */

const IdParam = z.object({ id: z.string().regex(/^\d+$/) });

const CreateSchema = z.object({
  titulo: z.string().min(1),
  descripcion: z.string().optional().nullable(),
  // Acepta ISO o 'YYYY-MM-DD HH:MM:SS'
  fecha_inicio: z.string().min(10),
  fecha_fin: z.string().min(10),
});

const UpdateSchema = z.object({
  titulo: z.string().min(1).optional(),
  descripcion: z.string().optional().nullable(),
  fecha_inicio: z.string().min(10).optional(),
  fecha_fin: z.string().min(10).optional(),
});

// Normaliza fecha de ISO o 'YYYY-MM-DD HH:MM:SS' a 'YYYY-MM-DD HH:MM:SS'
function toSQLDateTime(input: string): string | null {
  if (!input) return null;
  // Si ya viene como 'YYYY-MM-DD HH:MM:SS', la dejamos
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(input)) return input;

  // Intentamos parsear ISO u otros
  const d = new Date(input);
  if (Number.isNaN(d.valueOf())) return null;

  // Armamos en local (ajusta si requieres UTC)
  const pad = (n: number) => String(n).padStart(2, '0');
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const HH = pad(d.getHours());
  const MM = pad(d.getMinutes());
  const SS = pad(d.getSeconds());
  return `${yyyy}-${mm}-${dd} ${HH}:${MM}:${SS}`;
}

export default async function eventos(app: FastifyInstance) {
  // Health
  app.get('/health', async () => ({
    module: 'eventos',
    status: 'ready',
    timestamp: new Date().toISOString(),
  }));

  // GET /eventos
  app.get('/', async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      const [rows] = await db.query(
        'SELECT id, titulo, descripcion, fecha_inicio, fecha_fin, creado_en, actualizado_en FROM eventos ORDER BY fecha_inicio DESC, id DESC'
      );
      reply.send({ ok: true, items: rows });
    } catch (err: any) {
      reply.code(500).send({ ok: false, message: 'Error al listar eventos', error: err?.message });
    }
  });

  // GET /eventos/:id
  app.get('/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = IdParam.safeParse((req as any).params);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: 'ID inválido' });
    const id = Number(parsed.data.id);

    try {
      const [rows]: any = await db.query(
        'SELECT id, titulo, descripcion, fecha_inicio, fecha_fin, creado_en, actualizado_en FROM eventos WHERE id = ? LIMIT 1',
        [id]
      );
      if (!rows || rows.length === 0) return reply.code(404).send({ ok: false, message: 'No encontrado' });
      reply.send({ ok: true, item: rows[0] });
    } catch (err: any) {
      reply.code(500).send({ ok: false, message: 'Error al obtener evento', error: err?.message });
    }
  });

  // POST /eventos
  app.post('/', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = CreateSchema.safeParse((req as any).body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, message: 'Payload inválido', errors: parsed.error.flatten() });
    }

    const { titulo, descripcion, fecha_inicio, fecha_fin } = parsed.data;

    // Normalización fecha
    const ini = toSQLDateTime(fecha_inicio);
    const fin = toSQLDateTime(fecha_fin);
    if (!ini || !fin) {
      return reply.code(400).send({ ok: false, message: 'Formato de fecha inválido' });
    }
    // Validar rango
    if (new Date(ini) >= new Date(fin)) {
      return reply.code(400).send({ ok: false, message: 'fecha_fin debe ser mayor que fecha_inicio' });
    }

    try {
      const [result]: any = await db.query(
        `INSERT INTO eventos (titulo, descripcion, fecha_inicio, fecha_fin, creado_en, actualizado_en)
         VALUES (?, ?, ?, ?, NOW(), NOW())`,
        [titulo, descripcion ?? null, ini, fin]
      );

      const id = result.insertId;
      const [rows]: any = await db.query(
        'SELECT id, titulo, descripcion, fecha_inicio, fecha_fin, creado_en, actualizado_en FROM eventos WHERE id = ?',
        [id]
      );

      reply.code(201).send({ ok: true, item: rows[0] });
    } catch (err: any) {
      reply.code(500).send({ ok: false, message: 'Error al crear evento', error: err?.message });
    }
  });

  // PUT /eventos/:id
  app.put('/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const pid = IdParam.safeParse((req as any).params);
    if (!pid.success) return reply.code(400).send({ ok: false, message: 'ID inválido' });
    const id = Number(pid.data.id);

    const parsed = UpdateSchema.safeParse((req as any).body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, message: 'Payload inválido', errors: parsed.error.flatten() });
    }

    const changes: Record<string, any> = {};
    if (parsed.data.titulo !== undefined) changes.titulo = parsed.data.titulo;
    if (parsed.data.descripcion !== undefined) changes.descripcion = parsed.data.descripcion ?? null;
    if (parsed.data.fecha_inicio !== undefined) {
      const ini = toSQLDateTime(parsed.data.fecha_inicio);
      if (!ini) return reply.code(400).send({ ok: false, message: 'fecha_inicio inválida' });
      changes.fecha_inicio = ini;
    }
    if (parsed.data.fecha_fin !== undefined) {
      const fin = toSQLDateTime(parsed.data.fecha_fin);
      if (!fin) return reply.code(400).send({ ok: false, message: 'fecha_fin inválida' });
      changes.fecha_fin = fin;
    }

    // Si ambos vienen, validamos el rango
    if (changes.fecha_inicio && changes.fecha_fin) {
      if (new Date(changes.fecha_inicio) >= new Date(changes.fecha_fin)) {
        return reply.code(400).send({ ok: false, message: 'fecha_fin debe ser mayor que fecha_inicio' });
      }
    }

    if (Object.keys(changes).length === 0) {
      return reply.code(400).send({ ok: false, message: 'No hay campos para actualizar' });
    }

    try {
      await db.query('UPDATE eventos SET ?, actualizado_en = NOW() WHERE id = ?', [changes, id]);

      const [rows]: any = await db.query(
        'SELECT id, titulo, descripcion, fecha_inicio, fecha_fin, creado_en, actualizado_en FROM eventos WHERE id = ?',
        [id]
      );
      if (!rows || rows.length === 0) return reply.code(404).send({ ok: false, message: 'No encontrado' });

      reply.send({ ok: true, item: rows[0] });
    } catch (err: any) {
      reply.code(500).send({ ok: false, message: 'Error al actualizar evento', error: err?.message });
    }
  });

  // DELETE /eventos/:id
  app.delete('/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = IdParam.safeParse((req as any).params);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: 'ID inválido' });
    const id = Number(parsed.data.id);

    try {
      const [result]: any = await db.query('DELETE FROM eventos WHERE id = ?', [id]);
      if (result.affectedRows === 0) return reply.code(404).send({ ok: false, message: 'No encontrado' });
      reply.send({ ok: true, deleted: id });
    } catch (err: any) {
      reply.code(500).send({ ok: false, message: 'Error al eliminar evento', error: err?.message });
    }
  });
}
