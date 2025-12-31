// src/routers/portal_apoderado.ts
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { getDb } from "../db";

const JWT_SECRET = process.env.JWT_SECRET as string;

type ApoderadoToken = { type: "apoderado"; rut: string };

function verifyApoderadoToken(authHeader?: string): ApoderadoToken | null {
  if (!authHeader) return null;
  const [bearer, token] = authHeader.split(" ");
  if (bearer !== "Bearer" || !token) return null;

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    if (decoded?.type !== "apoderado") return null;

    const rut = String(decoded?.rut ?? "");
    if (!/^\d{8}$/.test(rut)) return null;

    return { type: "apoderado", rut };
  } catch {
    return null;
  }
}

async function requireApoderadoPortalOk(rut: string) {
  const db = getDb();
  const [rows] = await db.query<any[]>(
    `SELECT must_change_password
     FROM apoderados_auth
     WHERE rut_apoderado = ?
     LIMIT 1`,
    [rut]
  );

  if (!rows?.length) return { ok: false as const, code: 401, message: "UNAUTHORIZED" };
  if (Number(rows[0].must_change_password) === 1) {
    return { ok: false as const, code: 403, message: "PASSWORD_CHANGE_REQUIRED" };
  }
  return { ok: true as const };
}

const RutJugadorParam = z.object({ rut: z.string().regex(/^\d{8}$/) });

/** helpers para normalizar salida */
const safeNum = (v: any) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export default async function portal_apoderado(
  app: FastifyInstance,
  _opts: FastifyPluginOptions
) {
  /* ──────────────────────────────────────────────────────────────
     GET /api/portal-apoderado/mis-jugadores
     - Devuelve jugadores asociados al apoderado, con nombres de catálogos
  ────────────────────────────────────────────────────────────── */
  app.get("/mis-jugadores", async (req, reply) => {
    const tokenData = verifyApoderadoToken(req.headers.authorization);
    if (!tokenData) {
      return reply.code(401).send({ ok: false, message: "UNAUTHORIZED" });
    }

    const guard = await requireApoderadoPortalOk(tokenData.rut);
    if (!guard.ok) {
      return reply.code(guard.code).send({ ok: false, message: guard.message });
    }

    const db = getDb();

    // ✅ Traemos los nombres por JOIN para que el frontend muestre “bonito”
    const [rows] = await db.query<any[]>(
      `SELECT
          j.rut_jugador,
          j.nombre_jugador,
          j.estado_id,
          j.categoria_id,
          j.posicion_id,

          e.nombre  AS estado_nombre,
          c.nombre  AS categoria_nombre,
          p.nombre  AS posicion_nombre

       FROM jugadores j
       LEFT JOIN estado     e ON e.id = j.estado_id
       LEFT JOIN categorias c ON c.id = j.categoria_id
       LEFT JOIN posiciones p ON p.id = j.posicion_id

       WHERE j.rut_apoderado = ?
       ORDER BY j.nombre_jugador ASC`,
      [tokenData.rut]
    );

    // Normalizamos un poquito para que sea consistente con el resumen
    const jugadores = (rows || []).map((r) => ({
      rut_jugador: r.rut_jugador,
      nombre_jugador: r.nombre_jugador,

      estado_id: r.estado_id,
      categoria_id: r.categoria_id,
      posicion_id: r.posicion_id,

      estado: r.estado_nombre ? { id: safeNum(r.estado_id), nombre: r.estado_nombre } : null,
      categoria: r.categoria_nombre ? { id: safeNum(r.categoria_id), nombre: r.categoria_nombre } : null,
      posicion: r.posicion_nombre ? { id: safeNum(r.posicion_id), nombre: r.posicion_nombre } : null,
    }));

    return reply.send({ ok: true, jugadores });
  });

  /* ──────────────────────────────────────────────────────────────
     GET /api/portal-apoderado/jugadores/:rut/resumen
     - 1 endpoint: jugador + pagos + (opcional) estadisticas
     - jugador viene enriquecido (categoria/posicion/estado/sucursal/etc)
     - pagos vienen enriquecidos (tipo/medio/situacion con nombre)
  ────────────────────────────────────────────────────────────── */
  app.get("/jugadores/:rut/resumen", async (req, reply) => {
    const tokenData = verifyApoderadoToken(req.headers.authorization);
    if (!tokenData) return reply.code(401).send({ ok: false, message: "UNAUTHORIZED" });

    const guard = await requireApoderadoPortalOk(tokenData.rut);
    if (!guard.ok) return reply.code(guard.code).send({ ok: false, message: guard.message });

    const parsed = RutJugadorParam.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: "BAD_REQUEST" });

    const rutJugador = parsed.data.rut;
    const db = getDb();

    // ✅ valida pertenencia
    const [own] = await db.query<any[]>(
      `SELECT 1
       FROM jugadores
       WHERE rut_jugador = ? AND rut_apoderado = ?
       LIMIT 1`,
      [rutJugador, tokenData.rut]
    );
    if (!own?.length) return reply.code(403).send({ ok: false, message: "FORBIDDEN" });

    // ✅ jugador con JOIN a catálogos para nombres
    const [jugRows] = await db.query<any[]>(
      `SELECT
          j.id,
          j.rut_jugador,
          j.nombre_jugador,
          j.fecha_nacimiento,
          j.edad,
          j.telefono,
          j.email,
          j.direccion,
          j.comuna_id,
          j.posicion_id,
          j.categoria_id,
          j.talla_polera,
          j.talla_short,
          j.establec_educ_id,
          j.prevision_medica_id,
          j.nombre_apoderado,
          j.rut_apoderado,
          j.telefono_apoderado,
          j.peso,
          j.estatura,
          j.observaciones,
          j.estado_id,
          j.estadistica_id,
          j.sucursal_id,

          -- Nombres de catálogos
          c.nombre  AS categoria_nombre,
          pz.nombre AS posicion_nombre,
          es.nombre AS estado_nombre,
          sr.nombre AS sucursal_nombre,
          co.nombre AS comuna_nombre,
          ee.nombre AS establec_educ_nombre,
          pm.nombre AS prevision_medica_nombre

       FROM jugadores j
       LEFT JOIN categorias              c  ON c.id  = j.categoria_id
       LEFT JOIN posiciones              pz ON pz.id = j.posicion_id
       LEFT JOIN estado                  es ON es.id = j.estado_id
       LEFT JOIN sucursales_real         sr ON sr.id = j.sucursal_id
       LEFT JOIN comunas                 co ON co.id = j.comuna_id
       LEFT JOIN establec_educ           ee ON ee.id = j.establec_educ_id
       LEFT JOIN prevision_medica        pm ON pm.id = j.prevision_medica_id

       WHERE j.rut_jugador = ?
       LIMIT 1`,
      [rutJugador]
    );

    const r = jugRows?.[0] ?? null;
    if (!r) return reply.code(404).send({ ok: false, message: "NOT_FOUND" });

    // Construimos el jugador con objetos tal cual espera tu frontend
    const jugador = {
      id: r.id,
      rut_jugador: r.rut_jugador,
      nombre_jugador: r.nombre_jugador,
      fecha_nacimiento: r.fecha_nacimiento,
      edad: r.edad,
      telefono: r.telefono,
      email: r.email,
      direccion: r.direccion,
      comuna_id: r.comuna_id,
      posicion_id: r.posicion_id,
      categoria_id: r.categoria_id,
      talla_polera: r.talla_polera,
      talla_short: r.talla_short,
      establec_educ_id: r.establec_educ_id,
      prevision_medica_id: r.prevision_medica_id,
      nombre_apoderado: r.nombre_apoderado,
      rut_apoderado: r.rut_apoderado,
      telefono_apoderado: r.telefono_apoderado,
      peso: r.peso,
      estatura: r.estatura,
      observaciones: r.observaciones,
      estado_id: r.estado_id,
      estadistica_id: r.estadistica_id,
      sucursal_id: r.sucursal_id,

      // ✅ objetos enriquecidos
      categoria: r.categoria_nombre ? { id: safeNum(r.categoria_id), nombre: r.categoria_nombre } : null,
      posicion: r.posicion_nombre ? { id: safeNum(r.posicion_id), nombre: r.posicion_nombre } : null,
      estado: r.estado_nombre ? { id: safeNum(r.estado_id), nombre: r.estado_nombre } : null,
      sucursal: r.sucursal_nombre ? { id: safeNum(r.sucursal_id), nombre: r.sucursal_nombre } : null,
      comuna: r.comuna_nombre ? { id: safeNum(r.comuna_id), nombre: r.comuna_nombre } : null,
      establec_educ: r.establec_educ_nombre ? { id: safeNum(r.establec_educ_id), nombre: r.establec_educ_nombre } : null,
      prevision_medica: r.prevision_medica_nombre ? { id: safeNum(r.prevision_medica_id), nombre: r.prevision_medica_nombre } : null,
    };

    // ✅ pagos enriquecidos con nombre (tipo/medio/situacion)
    const [payRows] = await db.query<any[]>(
      `SELECT
          p.*,
          tp.id AS tp_id, tp.nombre AS tp_nombre,
          mp.id AS mp_id, mp.nombre AS mp_nombre,
          sp.id AS sp_id, sp.nombre AS sp_nombre
       FROM pagos_jugador p
       LEFT JOIN tipo_pago tp      ON tp.id = p.tipo_pago_id
       LEFT JOIN medio_pago mp     ON mp.id = p.medio_pago_id
       LEFT JOIN situacion_pago sp ON sp.id = p.situacion_pago_id
       WHERE p.jugador_rut = ?
       ORDER BY p.fecha_pago DESC, p.id DESC`,
      [rutJugador]
    );

    const pagos = (payRows || []).map((x) => ({
      id: x.id,
      jugador_rut: x.jugador_rut,
      tipo_pago_id: x.tipo_pago_id,
      situacion_pago_id: x.situacion_pago_id,
      medio_pago_id: x.medio_pago_id,
      monto: Number(x.monto || 0),
      fecha_pago: x.fecha_pago,
      comprobante_url: x.comprobante_url ?? null,
      observaciones: x.observaciones ?? null,

      // ✅ lo que tu frontend ya intenta leer:
      tipo_pago: { id: x.tp_id ?? x.tipo_pago_id, nombre: x.tp_nombre ?? null },
      medio_pago: { id: x.mp_id ?? x.medio_pago_id, nombre: x.mp_nombre ?? null },
      situacion_pago: { id: x.sp_id ?? x.situacion_pago_id, nombre: x.sp_nombre ?? null },
    }));

    // ✅ estadísticas (opcional). Si no quieres, déjalo null.
    // Aquí uso estadistica_id del jugador, porque en tu tabla jugadores existe.
    let estadisticas: any = null;
    if (r.estadistica_id) {
      try {
        const [st] = await db.query<any[]>(
          `SELECT * FROM estadisticas WHERE id = ? LIMIT 1`,
          [r.estadistica_id]
        );
        estadisticas = st?.[0] ?? null;
      } catch {
        estadisticas = null;
      }
    }

    return reply.send({ ok: true, jugador, estadisticas, pagos });
  });

  /* ──────────────────────────────────────────────────────────────
     GET /api/portal-apoderado/jugadores/:rut/pagos
     - Opcional: si ya usas /resumen, podrías eliminarlo.
     - Lo dejo, pero enriquecido (para que no muestre IDs).
  ────────────────────────────────────────────────────────────── */
  app.get("/jugadores/:rut/pagos", async (req, reply) => {
    const tokenData = verifyApoderadoToken(req.headers.authorization);
    if (!tokenData) {
      return reply.code(401).send({ ok: false, message: "UNAUTHORIZED" });
    }

    const guard = await requireApoderadoPortalOk(tokenData.rut);
    if (!guard.ok) {
      return reply.code(guard.code).send({ ok: false, message: guard.message });
    }

    const parsed = RutJugadorParam.safeParse(req.params);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, message: "BAD_REQUEST" });
    }

    const rutJugador = parsed.data.rut;
    const db = getDb();

    const [own] = await db.query<any[]>(
      `SELECT 1
       FROM jugadores
       WHERE rut_jugador = ? AND rut_apoderado = ?
       LIMIT 1`,
      [rutJugador, tokenData.rut]
    );
    if (!own?.length) {
      return reply.code(403).send({ ok: false, message: "FORBIDDEN" });
    }

    const [payRows] = await db.query<any[]>(
      `SELECT
          p.*,
          tp.id AS tp_id, tp.nombre AS tp_nombre,
          mp.id AS mp_id, mp.nombre AS mp_nombre,
          sp.id AS sp_id, sp.nombre AS sp_nombre
       FROM pagos_jugador p
       LEFT JOIN tipo_pago tp      ON tp.id = p.tipo_pago_id
       LEFT JOIN medio_pago mp     ON mp.id = p.medio_pago_id
       LEFT JOIN situacion_pago sp ON sp.id = p.situacion_pago_id
       WHERE p.jugador_rut = ?
       ORDER BY p.fecha_pago DESC, p.id DESC`,
      [rutJugador]
    );

    const pagos = (payRows || []).map((x) => ({
      id: x.id,
      jugador_rut: x.jugador_rut,
      tipo_pago_id: x.tipo_pago_id,
      situacion_pago_id: x.situacion_pago_id,
      medio_pago_id: x.medio_pago_id,
      monto: Number(x.monto || 0),
      fecha_pago: x.fecha_pago,
      comprobante_url: x.comprobante_url ?? null,
      observaciones: x.observaciones ?? null,
      tipo_pago: { id: x.tp_id ?? x.tipo_pago_id, nombre: x.tp_nombre ?? null },
      medio_pago: { id: x.mp_id ?? x.medio_pago_id, nombre: x.mp_nombre ?? null },
      situacion_pago: { id: x.sp_id ?? x.situacion_pago_id, nombre: x.sp_nombre ?? null },
    }));

    return reply.send({ ok: true, pagos });
  });
}
