// src/routers/pagos_jugador.ts
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
/* Constantes de negocio                                         */
/* ────────────────────────────────────────────────────────────── */

const MENSUALIDAD_TIPO_PAGO_ID = 3; // ajusta según tu catálogo real
const DIA_CORTE_VENCIDO = 5;

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
  limit: z.coerce.number().int().positive().max(1000).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});

// 🔎 Filtros opcionales para listar
const ListQuery = PageQuery.extend({
  year: z.coerce.number().int().optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
  tipo_pago_id: z.coerce.number().int().positive().optional(),
  jugador_rut: z.coerce.number().int().positive().optional(),
});

/* ────────────────────────────────────────────────────────────── */
/* Endpoint pagos_jugador                                        */
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

  /* ───────── GET estado de cuenta mensualidad (agregado por jugador) ───────── */
  /* ───────── GET estado de cuenta (por jugador) ───────── */
  app.get('/estado-cuenta', async (req, reply) => {
    try {
      const now = new Date();
      const currentYear = now.getFullYear();
      const currentMonth = now.getMonth() + 1;
      const currentDay = now.getDate();

      // Regla solo para MENSUALIDAD:
      //  - 1 al 5: PAGADO (aunque no haya mensualidad registrada aún)
      //  - 6 en adelante: VENCIDO si no hay mensualidad del mes en curso
      let baseEstadoSinPago: 'PAGADO' | 'VENCIDO';
      if (currentDay <= 5) baseEstadoSinPago = 'PAGADO';
      else baseEstadoSinPago = 'VENCIDO';

      /* 1) Traer todos los jugadores + su categoría (si existe) */
      const [jugRows]: any = await db.query(
        `SELECT j.*,
                c.nombre AS categoria_nombre
           FROM jugadores j
           LEFT JOIN categorias c ON c.id = j.categoria_id`
      );

      /* 2) Traer TODOS los pagos, con joins a tipo_pago, medio_pago, situacion_pago */
      const [pagoRows]: any = await db.query(
        `SELECT p.*,
                tp.id     AS tp_id,
                tp.nombre AS tp_nombre,
                mp.id     AS mp_id,
                mp.nombre AS mp_nombre,
                sp.id     AS sp_id,
                sp.nombre AS sp_nombre
           FROM pagos_jugador p
           LEFT JOIN tipo_pago tp      ON tp.id = p.tipo_pago_id
           LEFT JOIN medio_pago mp     ON mp.id = p.medio_pago_id
           LEFT JOIN situacion_pago sp ON sp.id = p.situacion_pago_id`
      );

      // Normalizar pagos al formato que espera el frontend
      const pagos = (pagoRows || []).map((r: any) => ({
        id: r.id,
        jugador_rut: r.jugador_rut,
        monto: Number(r.monto || 0),
        fecha_pago: r.fecha_pago,
        tipo_pago: {
          id: r.tp_id ?? r.tipo_pago_id,
          nombre: r.tp_nombre ?? null,
        },
        medio_pago: {
          id: r.mp_id ?? r.medio_pago_id,
          nombre: r.mp_nombre ?? null,
        },
        situacion_pago: {
          id: r.sp_id ?? r.situacion_pago_id,
          nombre: r.sp_nombre ?? null,
        },
        comprobante_url: r.comprobante_url ?? null,
        observaciones: r.observaciones ?? null,
      }));

      /* 3) Agrupar pagos por RUT y calcular año/mes */
      type PagoEnvuelto = {
        pago: any;
        year: number | null;
        month: number | null;
      };

      const pagosPorRut = new Map<string, PagoEnvuelto[]>();

      for (const p of pagos) {
        const rut = String(p.jugador_rut ?? '');
        if (!rut) continue;

        const d = p.fecha_pago ? new Date(p.fecha_pago) : null;
        const year = d && !isNaN(d.getTime()) ? d.getFullYear() : null;
        const month = d && !isNaN(d.getTime()) ? d.getMonth() + 1 : null;

        const arr = pagosPorRut.get(rut) || [];
        arr.push({ pago: p, year, month });
        pagosPorRut.set(rut, arr);
      }

      /* 4) Construir filas por jugador */
      const filas = (jugRows || []).map((j: any) => {
        const rut = String(j.rut_jugador ?? j.rut ?? '');
        const nombre =
          j.nombre_jugador ??
          j.nombre ??
          j.nombre_completo ??
          '—';

        const categoria =
          j.categoria_nombre ??
          j.categoria ??
          'Sin categoría';

        const arrAll = rut ? pagosPorRut.get(rut) || [] : [];

        // Solo pagos de Mensualidad
        const arrMensual = arrAll.filter(
          (x) => Number(x.pago?.tipo_pago?.id) === MENSUALIDAD_TIPO_PAGO_ID
        );

        // Mensualidades del mes actual
        const pagosMensualMesActual = arrMensual.filter(
          (x) => x.year === currentYear && x.month === currentMonth
        );

        // ➤ Lógica de estado SOLO para mensualidad
        let estadoMensualidad: 'PAGADO' | 'VENCIDO' = baseEstadoSinPago;
        if (pagosMensualMesActual.length > 0) {
          // Si hay al menos UNA mensualidad en el mes actual ⇒ PAGADO
          estadoMensualidad = 'PAGADO';
        }

        // Último pago de cualquier tipo (mensualidad, torneo, matrícula, etc.)
        let lastPago: any = null;
        if (arrAll.length > 0) {
          arrAll.sort((a, b) => {
            const da = a.pago.fecha_pago ? new Date(a.pago.fecha_pago).getTime() : 0;
            const db = b.pago.fecha_pago ? new Date(b.pago.fecha_pago).getTime() : 0;
            return db - da;
          });
          // 👉 IMPORTANTE: ya NO tocamos situacion_pago aquí
          lastPago = arrAll[0].pago;
        }

        return {
          rut,
          nombre,
          categoria,
          estadoMensualidad,
          lastPago,
        };
      });

      const mesLabel = new Intl.DateTimeFormat('es-CL', {
        month: 'long',
        year: 'numeric',
      }).format(now);

      reply.send({
        ok: true,
        filas,
        pagos, // todos los pagos, tal como están en la BD
        mes: {
          year: currentYear,
          month: currentMonth,
          dia_corte: DIA_CORTE_VENCIDO,
          label: mesLabel,
        },
      });
    } catch (err: any) {
      reply.code(500).send({
        ok: false,
        message: 'Error al calcular estado de cuenta',
        error: err?.message,
      });
    }
  });

  /* ───────── GET estado mensualidad (por jugador, tipo_pago_id = 3) ───────── */
  /* ───────── GET estado mensualidad (jugadores que deben mensualidad) ───────── */
  app.get('/mensualidad-estado', async (req, reply) => {
    try {
      const now = new Date();
      const currentYear = now.getFullYear();
      const currentMonth = now.getMonth() + 1;
      const currentDay = now.getDate();

      // 1) Traer TODOS los jugadores con su categoría
      const [jugRows]: any = await db.query(
        `SELECT j.*,
              c.nombre AS categoria_nombre
         FROM jugadores j
         LEFT JOIN categorias c ON c.id = j.categoria_id`
      );

      // 2) Traer la ÚLTIMA mensualidad (tipo_pago_id = 3) por jugador
      const [mensRows]: any = await db.query(
        `SELECT jugador_rut,
              MAX(fecha_pago) AS last_fecha
         FROM pagos_jugador
        WHERE tipo_pago_id = ?
        GROUP BY jugador_rut`,
        [MENSUALIDAD_TIPO_PAGO_ID]
      );

      // Map: rut → última fecha de mensualidad (YYYY-MM-DD como string)
      const lastMensPorRut = new Map<string, string | null>();
      for (const r of mensRows || []) {
        if (!r.jugador_rut) continue;

        let fechaStr: string | null = null;

        if (r.last_fecha instanceof Date) {
          // Si viene como Date, normalizamos a YYYY-MM-DD sin zona
          fechaStr = r.last_fecha.toISOString().slice(0, 10);
        } else if (typeof r.last_fecha === 'string') {
          // Si viene como string, nos quedamos con los primeros 10 caracteres
          fechaStr = r.last_fecha.slice(0, 10);
        }

        lastMensPorRut.set(String(r.jugador_rut), fechaStr);
      }

      // 3) Regla base según día actual
      //    1–5  => PAGADO para todos (aunque no hayan pagado nunca)
      //    6+   => depende de si tienen mensualidad en el mes en curso
      const baseEstadoSinPago: 'PAGADO' | 'VENCIDO' =
        currentDay <= DIA_CORTE_VENCIDO ? 'PAGADO' : 'VENCIDO';

      const filas: any[] = [];

      for (const j of jugRows || []) {
        const rut = String(j.rut_jugador ?? j.rut ?? '');
        const nombre =
          j.nombre_jugador ??
          j.nombre ??
          j.nombre_completo ??
          '—';

        const categoria =
          j.categoria_nombre ??
          j.categoria ??
          'Sin categoría';

        const lastFechaRaw = rut ? lastMensPorRut.get(rut) ?? null : null;

        let lastMensualidadFecha: string | null = null;
        let tieneMensualidadMesActual = false;

        if (lastFechaRaw) {
          const s = String(lastFechaRaw).slice(0, 10); // YYYY-MM-DD
          const [yStr, mStr] = s.split('-');
          const y = Number(yStr);
          const m = Number(mStr);

          if (!Number.isNaN(y) && !Number.isNaN(m)) {
            lastMensualidadFecha = s;
            if (y === currentYear && m === currentMonth) {
              tieneMensualidadMesActual = true;
            }
          }
        }

        let estadoMensualidad: 'PAGADO' | 'VENCIDO';

        if (currentDay <= DIA_CORTE_VENCIDO) {
          // 1 al 5: todos considerados PAGADO
          estadoMensualidad = 'PAGADO';
        } else {
          // 6 en adelante: solo PAGADO si tiene mensualidad del mes en curso
          estadoMensualidad = tieneMensualidadMesActual ? 'PAGADO' : 'VENCIDO';
        }

        // 👇 Clave: esta lista es SOLO de quienes DEBEN mensualidad
        if (estadoMensualidad !== 'VENCIDO') {
          continue;
        }

        filas.push({
          rut,
          nombre,
          categoria,
          estadoMensualidad,          // siempre VENCIDO en esta lista
          lastMensualidadFecha,       // última fecha en que pagó mensualidad (o null)
          tieneMensualidadMesActual,  // false aquí, por definición
        });
      }

      const mesLabel = new Intl.DateTimeFormat('es-CL', {
        month: 'long',
        year: 'numeric',
      }).format(now);

      reply.send({
        ok: true,
        mes: {
          year: currentYear,
          month: currentMonth,
          dia_corte: DIA_CORTE_VENCIDO,
          label: mesLabel,
        },
        filas,
      });
    } catch (err: any) {
      reply.code(500).send({
        ok: false,
        message: 'Error al calcular estado de mensualidad',
        error: err?.message,
      });
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
