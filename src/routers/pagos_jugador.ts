import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db';

/**
 * Tabla: pagos_jugador
 * Campos:
 *  id, jugador_rut, tipo_pago_id, situacion_pago_id, monto,
 *  fecha_pago (DATE/DATETIME), medio_pago_id,
 *  comprobante_url (NULL), observaciones (NULL)
 */

/* ────────────────────────────────────────────────────────────── */
/* Helpers                                                       */
/* ────────────────────────────────────────────────────────────── */

// Normaliza fecha a YYYY-MM-DD (compatible con DATE en MySQL)
function toSQLDate(input: string): string | null {
  if (!input) return null;
  const d = new Date(input);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

// Limpia body + alias + convierte "" → null
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

/* ────────────────────────────────────────────────────────────── */
/* Schemas                                                       */
/* ────────────────────────────────────────────────────────────── */

const IdParam = z.object({ id: z.coerce.number().int().positive() });
const RutParam = z.object({ jugador_rut: z.coerce.number().int().positive() });

const BaseSchema = z.object({
  jugador_rut: z.coerce.number().int().positive(),
  tipo_pago_id: z.coerce.number().int().positive(),
  situacion_pago_id: z.coerce.number().int().positive(),
  monto: z.coerce.number().nonnegative(),
  fecha_pago: z.string().min(10),
  medio_pago_id: z.coerce.number().int().positive(),
  comprobante_url: z.string().url().nullable().optional(),
  observaciones: z.string().nullable().optional(),
});

const CreateSchema = BaseSchema;
const UpdateSchema = BaseSchema.partial();

const PageQuery = z.object({
  limit: z.coerce.number().int().positive().max(200).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});

// 🔎 Nuevo: filtros opcionales para listar
const ListQuery = PageQuery.extend({
  year: z.coerce.number().int().optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
  tipo_pago_id: z.coerce.number().int().positive().optional(),
  jugador_rut: z.coerce.number().int().positive().optional(),
});

/* ────────────────────────────────────────────────────────────── */
/* Endpoint optimizado                                           */
/* ────────────────────────────────────────────────────────────── */

export default async function pagos_jugador(app: FastifyInstance) {
  // Health
  app.get('/health', async () => ({
    module: 'pagos_jugador',
    status: 'ready',
    timestamp: new Date().toISOString(),
  }));

  /* ───────── GET listado con filtros + paginación ───────── */
  app.get('/', async (req, reply) => {
    const queryParsed = ListQuery.parse((req as any).query);
    const { limit, offset, year, month, tipo_pago_id, jugador_rut } = queryParsed;

    try {
      let sql = `
        SELECT *
          FROM pagos_jugador
         WHERE 1 = 1
      `;
      const params: any[] = [];

      if (jugador_rut) {
        sql += ' AND jugador_rut = ?';
        params.push(jugador_rut);
      }

      if (tipo_pago_id) {
        sql += ' AND tipo_pago_id = ?';
        params.push(tipo_pago_id);
      }

      if (year) {
        sql += ' AND YEAR(fecha_pago) = ?';
        params.push(year);
      }

      if (month) {
        sql += ' AND MONTH(fecha_pago) = ?';
        params.push(month);
      }

      sql += `
         ORDER BY fecha_pago DESC, id DESC
         LIMIT ? OFFSET ?
      `;
      params.push(limit, offset);

      const [rows] = await db.query(sql, params);

      reply.send({
        ok: true,
        items: rows,
        limit,
        offset,
        filters: { year, month, tipo_pago_id, jugador_rut },
      });
    } catch (err: any) {
      reply
        .code(500)
        .send({ ok: false, message: 'Error al listar pagos', error: err?.message });
    }
  });

  /* ───────── GET por ID ───────── */
  app.get('/:id', async (req, reply) => {
    const parsed = IdParam.safeParse((req as any).params);
    if (!parsed.success)
      return reply.code(400).send({ ok: false, message: 'ID inválido' });

    try {
      const [rows]: any = await db.query(
        'SELECT * FROM pagos_jugador WHERE id = ? LIMIT 1',
        [parsed.data.id]
      );

      if (!rows?.length)
        return reply.code(404).send({ ok: false, message: 'Pago no encontrado' });

      reply.send({ ok: true, item: rows[0] });
    } catch (err: any) {
      reply
        .code(500)
        .send({ ok: false, message: 'Error al obtener pago', error: err?.message });
    }
  });

  /* ───────── GET por jugador_rut ───────── */
  app.get('/jugador/:jugador_rut', async (req, reply) => {
    const parsed = RutParam.safeParse((req as any).params);
    if (!parsed.success)
      return reply.code(400).send({ ok: false, message: 'RUT inválido' });

    try {
      const [rows] = await db.query(
        `SELECT *
           FROM pagos_jugador
          WHERE jugador_rut = ?
          ORDER BY fecha_pago DESC, id DESC`,
        [parsed.data.jugador_rut]
      );

      reply.send({ ok: true, items: rows });
    } catch (err: any) {
      reply.code(500).send({
        ok: false,
        message: 'Error al listar pagos por jugador',
        error: err?.message,
      });
    }
  });

  /* ───────── POST crear ───────── */
  app.post('/', async (req, reply) => {
    const raw = (req as any).body ?? {};
    const normalized = normalizeBody(raw);

    const parsed = CreateSchema.safeParse(normalized);
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        message: 'Payload inválido',
        errors: parsed.error.flatten(),
      });
    }

    const data = parsed.data;

    // Normalizar fecha
    data.fecha_pago = toSQLDate(data.fecha_pago)!;

    try {
      const [result]: any = await db.query('INSERT INTO pagos_jugador SET ?', [data]);
      reply.code(201).send({ ok: true, id: result.insertId, ...data });
    } catch (err: any) {
      reply
        .code(500)
        .send({ ok: false, message: 'Error al crear pago', error: err?.message });
    }
  });

  /* ───────── PUT actualizar ───────── */
  app.put('/:id', async (req, reply) => {
    const pid = IdParam.safeParse((req as any).params);
    if (!pid.success)
      return reply.code(400).send({ ok: false, message: 'ID inválido' });
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

    if (data.fecha_pago) {
      const sqlDate = toSQLDate(data.fecha_pago);
      if (!sqlDate)
        return reply.code(400).send({ ok: false, message: 'fecha_pago inválida' });
      data.fecha_pago = sqlDate;
    }

    if (Object.keys(data).length === 0)
      return reply
        .code(400)
        .send({ ok: false, message: 'No hay campos para actualizar' });

    try {
      const [result]: any = await db.query('UPDATE pagos_jugador SET ? WHERE id = ?', [
        data,
        id,
      ]);

      if (result.affectedRows === 0)
        return reply.code(404).send({ ok: false, message: 'Pago no encontrado' });

      reply.send({ ok: true, updated: { id, ...data } });
    } catch (err: any) {
      reply.code(500).send({
        ok: false,
        message: 'Error al actualizar pago',
        error: err?.message,
      });
    }
  });

  /* ───────── DELETE eliminar ───────── */
  app.delete('/:id', async (req, reply) => {
    const parsed = IdParam.safeParse((req as any).params);
    if (!parsed.success)
      return reply.code(400).send({ ok: false, message: 'ID inválido' });

    try {
      const [result]: any = await db.query('DELETE FROM pagos_jugador WHERE id = ?', [
        parsed.data.id,
      ]);

      if (result.affectedRows === 0)
        return reply.code(404).send({ ok: false, message: 'Pago no encontrado' });

      reply.send({ ok: true, deleted: parsed.data.id });
    } catch (err: any) {
      reply.code(500).send({
        ok: false,
        message: 'Error al eliminar pago',
        error: err?.message,
      });
    }
  });
}
