// src/routes/estadisticas.ts
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { db } from '../db';

// ─────────────────── Schemas ───────────────────
const IdParam = z.object({ id: z.string().regex(/^\d+$/) });
const EstadisticaIdParam = z.object({ estadistica_id: z.string().regex(/^\d+$/) });
const RutParam = z.object({ rut: z.string().min(1) });

const PageQuery = z.object({
  limit: z.coerce.number().int().positive().max(200).optional().default(50),
  offset: z.coerce.number().int().nonnegative().optional().default(0),
});

// Whitelist conceptual (nombres “deseados”)
const allowedKeys = new Set([
  'estadistica_id',
  'goles', 'asistencias', 'tiros_libres', 'penales', 'lesiones', 'tarjetas_amarillas', 'tarjetas_rojas',
  'tiros_arco', 'tiros_fuera', 'tiros_bloqueados', 'regates_exitosos', 'centros_acertados',
  'pases_clave', 'intercepciones', 'despejes', 'duelos_ganados', 'entradas_exitosas', 'bloqueos', 'recuperaciones',
  'pases_completados', 'pases_errados', 'posesion_perdida', 'offsides', 'faltas_cometidas', 'faltas_recibidas',
  'distancia_recorrida_km', 'sprints', 'duelos_aereos_ganados', 'minutos_jugados',
  'partidos_jugador', 'dias_baja', 'sanciones_federativas', 'torneos_convocados', 'titular_partidos',
]);

const CreateSchema = z.object({
  estadistica_id: z.coerce.number().int().positive(),
}).passthrough();

const UpdateSchema = z.object({}).passthrough();

// Helpers
function sqlErr(err: any) {
  return err?.sqlMessage || err?.message || 'DB error';
}

// Normaliza tipos: ints salvo distancia_recorrida_km (float)
function coerceNumbers(obj: Record<string, any>) {
  const out: Record<string, any> = { ...obj };
  for (const [k, v] of Object.entries(out)) {
    if (v === null || v === undefined || v === '') continue;

    if (k === 'distancia_recorrida_km') {
      const n = Number.parseFloat(String(v));
      out[k] = Number.isFinite(n) ? n : 0;
    } else if (allowedKeys.has(k)) {
      const n = Number.parseInt(String(v), 10);
      out[k] = Number.isFinite(n) ? n : 0;
    }
  }
  return out;
}

export default async function estadisticas(app: FastifyInstance) {
  // ─────────────────── Descubrir columnas reales de la tabla ───────────────────
  let dbColumns = new Set<string>();

  async function refreshDbColumns() {
    const [rows]: any = await db.query('SHOW COLUMNS FROM estadisticas');
    dbColumns = new Set(rows.map((r: any) => r.Field));
  }

  // llamar una vez al iniciar
  try {
    await refreshDbColumns();
  } catch (e) {
    app.log.error({ err: e }, 'No se pudieron leer columnas de "estadisticas"');
  }

  function filterToDbColumns(obj: Record<string, any>) {
    const accepted: Record<string, any> = {};
    const rejected: string[] = [];

    for (const [k, v] of Object.entries(obj)) {
      // Debe estar en whitelist conceptual y además existir de verdad en la tabla
      if (allowedKeys.has(k) && dbColumns.has(k)) {
        accepted[k] = v;
      } else {
        rejected.push(k);
      }
    }
    return { accepted, rejected };
  }

  // ───── Debug opcional: ver columnas detectadas ─────
  app.get('/debug/columns', async (_req, reply) => {
    reply.send({ ok: true, columns: Array.from(dbColumns) });
  });

  // Health
  app.get('/health', async () => ({
    module: 'estadisticas',
    status: 'ready',
    timestamp: new Date().toISOString(),
  }));

  // ─────────────────── Listado paginado ───────────────────
  app.get('/', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = PageQuery.safeParse((req as any).query);
    const { limit, offset } = parsed.success ? parsed.data : { limit: 50, offset: 0 };

    try {
      const [rows] = await db.query(
        'SELECT * FROM estadisticas ORDER BY id DESC LIMIT ? OFFSET ?',
        [limit, offset],
      );
      reply.send({ ok: true, items: rows, limit, offset });
    } catch (err: any) {
      reply.code(500).send({ ok: false, message: 'Error al listar', error: sqlErr(err) });
    }
  });

  // ─────────────────── Obtener por estadistica_id ───────────────────
  app.get('/estadistica/:estadistica_id', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = EstadisticaIdParam.safeParse((req as any).params);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: 'estadistica_id inválido' });
    const estadistica_id = Number(parsed.data.estadistica_id);

    try {
      const [rows]: any = await db.query(
        'SELECT * FROM estadisticas WHERE estadistica_id = ? ORDER BY id DESC',
        [estadistica_id],
      );
      reply.send({ ok: true, items: rows });
    } catch (err: any) {
      reply.code(500).send({ ok: false, message: 'Error al listar por estadistica_id', error: sqlErr(err) });
    }
  });

  // ─────────────────── Conveniencia por RUT ───────────────────
  app.get('/by-rut/:rut', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = RutParam.safeParse((req as any).params);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: 'RUT inválido' });
    const rut = parsed.data.rut;

    try {
      const [rows]: any = await db.query(
        `SELECT e.*
           FROM jugadores j
           JOIN estadisticas e ON e.estadistica_id = j.estadistica_id
          WHERE j.rut_jugador = ?
          ORDER BY e.id DESC`,
        [rut],
      );
      reply.send({ ok: true, items: rows });
    } catch (err: any) {
      reply.code(500).send({ ok: false, message: 'Error al listar por RUT', error: sqlErr(err) });
    }
  });

  // ─────────────────── Obtener por id ───────────────────
  app.get('/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = IdParam.safeParse((req as any).params);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: 'ID inválido' });
    const id = Number(parsed.data.id);

    try {
      const [rows]: any = await db.query('SELECT * FROM estadisticas WHERE id = ? LIMIT 1', [id]);
      if (!rows || rows.length === 0) return reply.code(404).send({ ok: false, message: 'No encontrado' });
      reply.send({ ok: true, item: rows[0] });
    } catch (err: any) {
      reply.code(500).send({ ok: false, message: 'Error al obtener', error: sqlErr(err) });
    }
  });

  // ─────────────────── Crear ───────────────────
  app.post('/', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = CreateSchema.safeParse((req as any).body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, message: 'Payload inválido', errors: parsed.error.flatten() });
    }

    const raw = coerceNumbers((req as any).body || {});
    const { accepted, rejected } = filterToDbColumns(raw);

    if (accepted.estadistica_id == null) {
      return reply.code(400).send({ ok: false, message: 'estadistica_id es requerido' });
    }

    try {
      const [result]: any = await db.query('INSERT INTO estadisticas SET ?', [accepted]);
      reply.code(201).send({ ok: true, id: result.insertId, ...accepted, rejected_keys: rejected });
    } catch (err: any) {
      reply.code(500).send({ ok: false, message: 'Error al crear', error: sqlErr(err), rejected_keys: rejected });
    }
  });

  // ─────────────────── Actualizar por estadistica_id ───────────────────
  app.put('/estadistica/:estadistica_id', async (req: FastifyRequest, reply: FastifyReply) => {
    const p = EstadisticaIdParam.safeParse((req as any).params);
    if (!p.success) return reply.code(400).send({ ok: false, message: 'estadistica_id inválido' });
    const estadistica_id = Number(p.data.estadistica_id);

    const raw = coerceNumbers((req as any).body || {});
    const { accepted, rejected } = filterToDbColumns(raw);
    delete accepted.estadistica_id; // no permitir cambiar el FK con este endpoint

    if (Object.keys(accepted).length === 0) {
      return reply.code(400).send({
        ok: false,
        message: 'No hay campos válidos para actualizar (ver rejected_keys).',
        rejected_keys: rejected,
      });
    }

    try {
      const [result]: any = await db.query(
        'UPDATE estadisticas SET ? WHERE estadistica_id = ?',
        [accepted, estadistica_id],
      );
      if (result.affectedRows === 0) return reply.code(404).send({ ok: false, message: 'No encontrado' });
      reply.send({ ok: true, updated: { estadistica_id, ...accepted }, rejected_keys: rejected });
    } catch (err: any) {
      reply.code(500).send({ ok: false, message: 'Error al actualizar', error: sqlErr(err), rejected_keys: rejected });
    }
  });

  // ─────────────────── Actualizar por id (PK) ───────────────────
  app.put('/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const pid = IdParam.safeParse((req as any).params);
    if (!pid.success) return reply.code(400).send({ ok: false, message: 'ID inválido' });
    const id = Number(pid.data.id);

    const raw = coerceNumbers((req as any).body || {});
    const { accepted, rejected } = filterToDbColumns(raw);

    if (Object.keys(accepted).length === 0) {
      return reply.code(400).send({
        ok: false,
        message: 'No hay campos válidos para actualizar (ver rejected_keys).',
        rejected_keys: rejected,
      });
    }

    try {
      const [result]: any = await db.query('UPDATE estadisticas SET ? WHERE id = ?', [accepted, id]);
      if (result.affectedRows === 0) return reply.code(404).send({ ok: false, message: 'No encontrado' });
      reply.send({ ok: true, updated: { id, ...accepted }, rejected_keys: rejected });
    } catch (err: any) {
      reply.code(500).send({ ok: false, message: 'Error al actualizar', error: sqlErr(err), rejected_keys: rejected });
    }
  });

  // ─────────────────── Eliminar por id (PK) ───────────────────
  app.delete('/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = IdParam.safeParse((req as any).params);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: 'ID inválido' });
    const id = Number(parsed.data.id);

    try {
      const [result]: any = await db.query('DELETE FROM estadisticas WHERE id = ?', [id]);
      if (result.affectedRows === 0) return reply.code(404).send({ ok: false, message: 'No encontrado' });
      reply.send({ ok: true, deleted: id });
    } catch (err: any) {
      reply.code(500).send({ ok: false, message: 'Error al eliminar', error: sqlErr(err) });
    }
  });
}
