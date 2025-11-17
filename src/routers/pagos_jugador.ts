import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { db } from '../db';

/**
 * Tabla: pagos_jugador
 * Campos:
 *  id, jugador_rut (NUMERIC/INT), tipo_pago_id, situacion_pago_id, monto,
 *  fecha_pago (DATE/DATETIME), medio_pago_id, comprobante_url (NULL), observaciones (NULL)
 */

// ──────────────────────────────────────────────────────────────────────────────
// Schemas (coerción numérica + validaciones)
const IdParam = z.object({ id: z.coerce.number().int().positive() });
const RutParam = z.object({ jugador_rut: z.coerce.number().int().positive() });

const BaseSchema = z.object({
  jugador_rut: z.coerce.number().int().positive(),
  tipo_pago_id: z.coerce.number().int().positive(),
  situacion_pago_id: z.coerce.number().int().positive(),
  monto: z.coerce.number().nonnegative(),
  // Acepta 'YYYY-MM-DD' o ISO; validación mínima de longitud
  fecha_pago: z.string().min(10),
  medio_pago_id: z.coerce.number().int().positive(),
  comprobante_url: z.string().url().nullable().optional(),
  observaciones: z.string().nullable().optional(),
});

const CreateSchema = BaseSchema;
const UpdateSchema = BaseSchema.partial();

// Normaliza aliases desde el frontend y convierte "" → null donde corresponde
function normalizeBody(raw: any) {
  const norm: any = {
    jugador_rut: raw.jugador_rut ?? raw.rut,
    tipo_pago_id: raw.tipo_pago_id ?? raw.tipo_id,
    situacion_pago_id: raw.situacion_pago_id ?? raw.situacion_id,
    monto: raw.monto,
    fecha_pago: raw.fecha_pago ?? raw.fecha,
    medio_pago_id: raw.medio_pago_id ?? raw.medio_id,
    comprobante_url: raw.comprobante_url ?? raw.comprobante,
    observaciones: raw.observaciones ?? raw.obs,
  };

  if (typeof norm.comprobante_url === 'string' && norm.comprobante_url.trim() === '') {
    norm.comprobante_url = null;
  }
  if (typeof norm.observaciones === 'string' && norm.observaciones.trim() === '') {
    norm.observaciones = null;
  }
  return norm;
}

// ──────────────────────────────────────────────────────────────────────────────
export default async function pagos_jugador(app: FastifyInstance) {
  // Health del módulo
  app.get('/health', async () => ({
    module: 'pagos_jugador',
    status: 'ready',
    timestamp: new Date().toISOString(),
  }));

  // GET /pagos-jugador
  app.get('/', async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      const [rows] = await db.query('SELECT * FROM pagos_jugador ORDER BY fecha_pago DESC, id DESC');
      reply.send({ ok: true, items: rows });
    } catch (err: any) {
      reply.code(500).send({ ok: false, message: 'Error al listar pagos', error: err?.message });
    }
  });

  // GET /pagos-jugador/:id
  app.get('/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = IdParam.safeParse((req as any).params);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: 'ID inválido' });

    const id = parsed.data.id;
    try {
      const [rows]: any = await db.query('SELECT * FROM pagos_jugador WHERE id = ? LIMIT 1', [id]);
      if (!rows || rows.length === 0)
        return reply.code(404).send({ ok: false, message: 'Pago no encontrado' });
      reply.send({ ok: true, item: rows[0] });
    } catch (err: any) {
      reply.code(500).send({ ok: false, message: 'Error al obtener pago', error: err?.message });
    }
  });

  // GET /pagos-jugador/jugador/:jugador_rut
  app.get('/jugador/:jugador_rut', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = RutParam.safeParse((req as any).params);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: 'RUT inválido' });

    const jugador_rut = parsed.data.jugador_rut;
    try {
      const [rows] = await db.query(
        'SELECT * FROM pagos_jugador WHERE jugador_rut = ? ORDER BY fecha_pago DESC, id DESC',
        [jugador_rut]
      );
      reply.send({ ok: true, items: rows });
    } catch (err: any) {
      reply.code(500).send({ ok: false, message: 'Error al listar pagos por jugador', error: err?.message });
    }
  });

  // POST /pagos-jugador
  app.post('/', async (req: FastifyRequest, reply: FastifyReply) => {
    const raw = (req as any).body ?? {};
    const normalized = normalizeBody(raw);

    const parsed = CreateSchema.safeParse(normalized);
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        message: 'Payload inválido',
        errors: parsed.error.flatten(), // frontend ahora lo consume
      });
    }

    const data = parsed.data;
    try {
      const [result]: any = await db.query('INSERT INTO pagos_jugador SET ?', [data]);
      reply.code(201).send({ ok: true, id: result.insertId, ...data });
    } catch (err: any) {
      reply.code(500).send({ ok: false, message: 'Error al crear pago', error: err?.message });
    }
  });

  // PUT /pagos-jugador/:id
  app.put('/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const pid = IdParam.safeParse((req as any).params);
    if (!pid.success) return reply.code(400).send({ ok: false, message: 'ID inválido' });
    const id = pid.data.id;

    const raw = (req as any).body ?? {};
    const normalized = normalizeBody(raw);

    const parsed = UpdateSchema.safeParse(normalized);
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        message: 'Payload inválido',
        errors: parsed.error.flatten(),
      });
    }

    const data = parsed.data;
    if (Object.keys(data).length === 0)
      return reply.code(400).send({ ok: false, message: 'No hay campos para actualizar' });

    try {
      const [result]: any = await db.query('UPDATE pagos_jugador SET ? WHERE id = ?', [data, id]);
      if (result.affectedRows === 0)
        return reply.code(404).send({ ok: false, message: 'Pago no encontrado' });
      reply.send({ ok: true, updated: { id, ...data } });
    } catch (err: any) {
      reply.code(500).send({ ok: false, message: 'Error al actualizar pago', error: err?.message });
    }
  });

  // DELETE /pagos-jugador/:id
  app.delete('/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = IdParam.safeParse((req as any).params);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: 'ID inválido' });

    const id = parsed.data.id;
    try {
      const [result]: any = await db.query('DELETE FROM pagos_jugador WHERE id = ?', [id]);
      if (result.affectedRows === 0)
        return reply.code(404).send({ ok: false, message: 'Pago no encontrado' });
      reply.send({ ok: true, deleted: id });
    } catch (err: any) {
      reply.code(500).send({ ok: false, message: 'Error al eliminar pago', error: err?.message });
    }
  });
}
