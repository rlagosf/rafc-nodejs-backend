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

const hasB64 = (v: any) => {
  const s = String(v ?? "").trim();
  return s.length > 50; // umbral razonable
};

const cleanBase64 = (raw: any) => {
  const s = String(raw ?? "").trim();
  return s
    .replace(/^data:application\/pdf;base64,/, "")
    .replace(/^data:.*;base64,/, "")
    .replace(/\s+/g, "");
};

export default async function portal_apoderado(
  app: FastifyInstance,
  _opts: FastifyPluginOptions
) {
  /* ──────────────────────────────────────────────────────────────
     GET /api/portal-apoderado/mis-jugadores
     - Devuelve jugadores asociados al apoderado, con nombres de catálogos
     - Incluye tiene_contrato (boolean)
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

    const [rows] = await db.query<any[]>(
      `SELECT
          j.rut_jugador,
          j.nombre_jugador,
          j.estado_id,
          j.categoria_id,
          j.posicion_id,

          -- bandera liviana (no manda base64)
          (j.contrato_prestacion IS NOT NULL AND j.contrato_prestacion <> '') AS tiene_contrato,

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

    const jugadores = (rows || []).map((r) => ({
      rut_jugador: r.rut_jugador,
      nombre_jugador: r.nombre_jugador,

      estado_id: r.estado_id,
      categoria_id: r.categoria_id,
      posicion_id: r.posicion_id,

      tiene_contrato: Boolean(r.tiene_contrato),

      estado: r.estado_nombre ? { id: safeNum(r.estado_id), nombre: r.estado_nombre } : null,
      categoria: r.categoria_nombre ? { id: safeNum(r.categoria_id), nombre: r.categoria_nombre } : null,
      posicion: r.posicion_nombre ? { id: safeNum(r.posicion_id), nombre: r.posicion_nombre } : null,
    }));

    return reply.send({ ok: true, jugadores });
  });

  /* ──────────────────────────────────────────────────────────────
     GET /api/portal-apoderado/jugadores/:rut/resumen
     - 1 endpoint: jugador + pagos + (opcional) estadisticas
     - jugador viene enriquecido
     - pagos vienen enriquecidos
     - Incluye jugador.tiene_contrato (boolean)
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

    // valida pertenencia
    const [own] = await db.query<any[]>(
      `SELECT 1
       FROM jugadores
       WHERE rut_jugador = ? AND rut_apoderado = ?
       LIMIT 1`,
      [rutJugador, tokenData.rut]
    );
    if (!own?.length) return reply.code(403).send({ ok: false, message: "FORBIDDEN" });

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

          -- bandera liviana
          (j.contrato_prestacion IS NOT NULL AND j.contrato_prestacion <> '') AS tiene_contrato,

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

      // ✅ solo bandera (NO base64)
      tiene_contrato: Boolean(r.tiene_contrato),

      // objetos enriquecidos
      categoria: r.categoria_nombre ? { id: safeNum(r.categoria_id), nombre: r.categoria_nombre } : null,
      posicion: r.posicion_nombre ? { id: safeNum(r.posicion_id), nombre: r.posicion_nombre } : null,
      estado: r.estado_nombre ? { id: safeNum(r.estado_id), nombre: r.estado_nombre } : null,
      sucursal: r.sucursal_nombre ? { id: safeNum(r.sucursal_id), nombre: r.sucursal_nombre } : null,
      comuna: r.comuna_nombre ? { id: safeNum(r.comuna_id), nombre: r.comuna_nombre } : null,
      establec_educ: r.establec_educ_nombre ? { id: safeNum(r.establec_educ_id), nombre: r.establec_educ_nombre } : null,
      prevision_medica: r.prevision_medica_nombre ? { id: safeNum(r.prevision_medica_id), nombre: r.prevision_medica_nombre } : null,
    };

    // pagos enriquecidos
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

    // estadísticas (opcional)
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
     ✅ NUEVO
     GET /api/portal-apoderado/jugadores/:rut/contrato
     - Devuelve PDF binario (application/pdf) para abrir en pestaña
  ────────────────────────────────────────────────────────────── */
  app.get("/jugadores/:rut/contrato", async (req, reply) => {
    const tokenData = verifyApoderadoToken(req.headers.authorization);
    if (!tokenData) return reply.code(401).send({ ok: false, message: "UNAUTHORIZED" });

    const guard = await requireApoderadoPortalOk(tokenData.rut);
    if (!guard.ok) return reply.code(guard.code).send({ ok: false, message: guard.message });

    const parsed = RutJugadorParam.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: "BAD_REQUEST" });

    const rutJugador = parsed.data.rut;
    const db = getDb();

    // valida pertenencia
    const [own] = await db.query<any[]>(
      `SELECT 1
       FROM jugadores
       WHERE rut_jugador = ? AND rut_apoderado = ?
       LIMIT 1`,
      [rutJugador, tokenData.rut]
    );
    if (!own?.length) return reply.code(403).send({ ok: false, message: "FORBIDDEN" });

    // trae contrato
    const [rows] = await db.query<any[]>(
      `SELECT contrato_prestacion, contrato_prestacion_mime, nombre_jugador
       FROM jugadores
       WHERE rut_jugador = ?
       LIMIT 1`,
      [rutJugador]
    );

    const r = rows?.[0];
    if (!r) return reply.code(404).send({ ok: false, message: "NOT_FOUND" });

    if (!hasB64(r.contrato_prestacion)) {
      return reply.code(404).send({ ok: false, message: "NO_CONTRATO" });
    }

    const mime = String(r.contrato_prestacion_mime || "application/pdf").toLowerCase();
    if (!mime.includes("application/pdf")) {
      return reply.code(415).send({ ok: false, message: "UNSUPPORTED_MEDIA_TYPE" });
    }

    const clean = cleanBase64(r.contrato_prestacion);

    let buf: Buffer;
    try {
      buf = Buffer.from(clean, "base64");
    } catch {
      return reply.code(500).send({ ok: false, message: "CONTRATO_INVALIDO" });
    }

    // headers para ver en navegador
    reply.header("Content-Type", "application/pdf");
    reply.header("Content-Disposition", `inline; filename="Contrato_${rutJugador}.pdf"`);
    reply.header("Cache-Control", "no-store, max-age=0");

    return reply.send(buf);
  });

  /* ──────────────────────────────────────────────────────────────
     GET /api/portal-apoderado/jugadores/:rut/pagos
     - Opcional si ya usas /resumen, pero lo dejamos.
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
