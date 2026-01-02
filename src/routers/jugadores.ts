// src/routers/jugadores.ts
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import { db } from "../db";

/**
 * ───────────────────────────────
 * Helpers FOTO (validación liviana)
 * ───────────────────────────────
 */
function isValidMime(m?: string) {
  return ["image/jpeg", "image/jpg", "image/png", "image/webp"].includes(
    String(m || "").toLowerCase()
  );
}

function approxBytesFromBase64(b64: string) {
  const s = b64.replace(/\s+/g, "");
  const padding = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  return Math.floor((s.length * 3) / 4) - padding;
}

function looksLikeBase64(b64: string) {
  const s = String(b64 || "").trim();
  if (!s) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(s);
}

function cleanBase64Payload(input: string) {
  // Si llega "data:image/png;base64,XXXX", lo deja como "XXXX"
  const s = String(input || "").trim();
  const idx = s.indexOf("base64,");
  if (s.startsWith("data:") && idx !== -1) return s.slice(idx + "base64,".length);
  return s;
}

/**
 * jugadores.estadistica_id es UNIQUE y FK -> estadisticas.estadistica_id
 */

// ───────── Schemas ─────────
const IdParam = z.object({
  id: z.string().regex(/^\d+$/),
});

const RutParam = z.object({
  rut: z.string().regex(/^\d{7,8}$/, "El RUT debe tener 7 u 8 dígitos (sin DV)"),
});

const PageQuery = z.object({
  limit: z.coerce.number().int().positive().max(200).optional().default(100),
  offset: z.coerce.number().int().nonnegative().optional().default(0),
  q: z.string().trim().min(1).max(100).optional(),
  include_inactivos: z.coerce.number().int().optional().default(0),
});

const BaseFields = {
  nombre_jugador: z.string().trim().min(1).optional(),
  rut_jugador: z.union([z.string().regex(/^\d{7,8}$/), z.number().int().min(1)]).optional(),
  email: z.string().email().optional(),
  telefono: z.string().trim().min(3).optional(),

  edad: z.union([z.number().int(), z.string().regex(/^\d+$/)]).optional(),
  peso: z.union([z.number(), z.string().regex(/^\d+(\.\d+)?$/)]).optional(),
  estatura: z.union([z.number(), z.string().regex(/^\d+(\.\d+)?$/)]).optional(),

  talla_polera: z.string().trim().optional(),
  talla_short: z.string().trim().optional(),
  nombre_apoderado: z.string().trim().optional(),
  rut_apoderado: z.union([z.string().regex(/^\d{7,8}$/), z.number().int().min(1)]).optional(),
  telefono_apoderado: z.string().trim().optional(),

  posicion_id: z.union([z.number().int(), z.string().regex(/^\d+$/)]).optional(),
  categoria_id: z.union([z.number().int(), z.string().regex(/^\d+$/)]).optional(),
  establec_educ_id: z.union([z.number().int(), z.string().regex(/^\d+$/)]).optional(),
  prevision_medica_id: z.union([z.number().int(), z.string().regex(/^\d+$/)]).optional(),
  estado_id: z.union([z.number().int(), z.string().regex(/^\d+$/)]).optional(),

  direccion: z.string().trim().optional(),
  comuna_id: z.union([z.number().int(), z.string().regex(/^\d+$/)]).optional(),

  observaciones: z.string().trim().optional(),
  fecha_nacimiento: z.union([z.string(), z.date()]).optional(),
  sucursal_id: z.union([z.number().int(), z.string().regex(/^\d+$/)]).nullable().optional(),

  // ✅ FOTO
  foto_base64: z.string().trim().nullable().optional(), // base64 puro (o dataURL, lo limpiamos)
  foto_mime: z.string().trim().nullable().optional(),   // image/jpeg, image/png, ...
};

const CreateSchema = z
  .object({
    ...BaseFields,
    nombre_jugador: z.string().trim().min(1),
    rut_jugador: z.union([z.string().regex(/^\d{7,8}$/), z.number().int().min(1)]),
  })
  .strict();

const UpdateSchema = z.object({ ...BaseFields }).strict();

/**
 * ✅ IMPORTANTÍSIMO:
 * faltaban foto_base64 y foto_mime
 */
const allowedKeys = new Set([
  'nombre_jugador', 'rut_jugador', 'email', 'telefono', 'edad', 'peso', 'estatura',
  'talla_polera', 'talla_short', 'nombre_apoderado', 'rut_apoderado', 'telefono_apoderado',
  'posicion_id', 'categoria_id', 'establec_educ_id', 'prevision_medica_id', 'estado_id',
  'direccion', 'comuna_id', 'observaciones', 'fecha_nacimiento', 'sucursal_id',
  // ✅ FOTO
  'foto_base64', 'foto_mime',
]);


function pickAllowed(body: Record<string, any>) {
  const out: Record<string, any> = {};
  for (const k in body) {
    if (allowedKeys.has(k)) out[k] = body[k];
  }
  return out;
}

function coerceForDB(row: Record<string, any>) {
  const out: Record<string, any> = { ...row };

  const asInt = [
    "edad", "posicion_id", "categoria_id", "establec_educ_id",
    "prevision_medica_id", "estado_id", "rut_jugador", "rut_apoderado",
    "sucursal_id", "comuna_id",
  ];

  for (const k of asInt) {
    if (k in out && out[k] !== null && out[k] !== undefined && out[k] !== "") {
      const n = Number.parseInt(String(out[k]), 10);
      out[k] = Number.isNaN(n) ? null : n;
    }
  }

  const asFloat = ["peso", "estatura"];
  for (const k of asFloat) {
    if (k in out && out[k] !== null && out[k] !== undefined && out[k] !== "") {
      const n = Number.parseFloat(String(out[k]));
      out[k] = Number.isNaN(n) ? null : n;
    }
  }

  if (typeof out.fecha_nacimiento === "string" || out.fecha_nacimiento instanceof Date) {
    const d = new Date(out.fecha_nacimiento);
    if (!Number.isNaN(d.getTime())) {
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, "0");
      const da = String(d.getUTCDate()).padStart(2, "0");
      out.fecha_nacimiento = `${y}-${m}-${da}`;
    } else if (typeof out.fecha_nacimiento === "string" && /^\d{4}-\d{2}-\d{2}$/.test(out.fecha_nacimiento)) {
      // ok
    } else {
      delete out.fecha_nacimiento;
    }
  }

  if (typeof out.email === "string") out.email = out.email.trim().toLowerCase();

  // ✅ normaliza vacíos
  for (const k of Object.keys(out)) {
    if (out[k] === "") out[k] = null;
  }

  // ✅ limpia dataURL si viene así
  if (typeof out.foto_base64 === "string") {
    out.foto_base64 = cleanBase64Payload(out.foto_base64);
  }

  delete (out as any).estadistica_id;
  return out;
}

function normalizeOut(row: any) {
  if (!row) return null;
  return {
    id: Number(row.id),
    rut_jugador: row.rut_jugador != null ? Number(row.rut_jugador) : null,
    nombre_jugador: String(row.nombre_jugador ?? ""),
    edad: row.edad != null ? Number(row.edad) : null,
    email: row.email ?? null,
    telefono: row.telefono ?? null,
    peso: row.peso != null ? Number(row.peso) : null,
    estatura: row.estatura != null ? Number(row.estatura) : null,
    talla_polera: row.talla_polera ?? null,
    talla_short: row.talla_short ?? null,
    nombre_apoderado: row.nombre_apoderado ?? null,
    rut_apoderado: row.rut_apoderado != null ? Number(row.rut_apoderado) : null,
    telefono_apoderado: row.telefono_apoderado ?? null,
    posicion_id: row.posicion_id != null ? Number(row.posicion_id) : null,
    categoria_id: row.categoria_id != null ? Number(row.categoria_id) : null,
    establec_educ_id: row.establec_educ_id != null ? Number(row.establec_educ_id) : null,
    prevision_medica_id: row.prevision_medica_id != null ? Number(row.prevision_medica_id) : null,
    estado_id: row.estado_id != null ? Number(row.estado_id) : null,
    direccion: row.direccion ?? null,
    comuna_id: row.comuna_id != null ? Number(row.comuna_id) : null,
    observaciones: row.observaciones ?? null,
    fecha_nacimiento: row.fecha_nacimiento ?? null,
    estadistica_id: row.estadistica_id != null ? Number(row.estadistica_id) : null,
    sucursal_id: row.sucursal_id != null ? Number(row.sucursal_id) : null,

    // ✅ FOTO
    foto_base64: row.foto_base64 ?? null,
    foto_mime: row.foto_mime ?? null,
    foto_updated_at: row.foto_updated_at ?? null,
  };
}

export default async function jugadores(app: FastifyInstance) {
  app.get("/health", async () => ({
    module: "jugadores",
    status: "ready",
    timestamp: new Date().toISOString(),
  }));

  // ───────── Listar ─────────
  app.get("/", async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = PageQuery.safeParse(req.query);
    const { limit, offset, q, include_inactivos } = parsed.success
      ? parsed.data
      : { limit: 100, offset: 0, q: undefined, include_inactivos: 0 };

    try {
      let sql =
        "SELECT id, rut_jugador, nombre_jugador, edad, email, telefono, peso, estatura, " +
        "talla_polera, talla_short, nombre_apoderado, rut_apoderado, telefono_apoderado, " +
        "posicion_id, categoria_id, establec_educ_id, prevision_medica_id, estado_id, " +
        "direccion, comuna_id, " +
        "observaciones, fecha_nacimiento, estadistica_id, sucursal_id, " +
        "foto_mime, foto_updated_at " + // ✅ NO mando foto_base64 en listado (optimiza)
        "FROM jugadores";

      const args: any[] = [];
      const where: string[] = [];

      if (Number(include_inactivos) !== 1) where.push("estado_id = 1");

      if (q) {
        const isNumeric = /^\d+$/.test(q);
        if (isNumeric) {
          where.push("(rut_jugador = ? OR nombre_jugador LIKE ? OR email LIKE ?)");
          args.push(Number(q), `%${q}%`, `%${q}%`);
        } else {
          where.push("(nombre_jugador LIKE ? OR email LIKE ?)");
          args.push(`%${q}%`, `%${q}%`);
        }
      }

      if (where.length) sql += " WHERE " + where.join(" AND ");
      sql += " ORDER BY nombre_jugador ASC, id ASC LIMIT ? OFFSET ?";
      args.push(limit, offset);

      const [rows]: any = await db.query(sql, args);

      reply.send({
        ok: true,
        items: (rows || []).map(normalizeOut),
        limit,
        offset,
        count: rows?.length ?? 0,
        filters: { q: q ?? null, include_inactivos: Number(include_inactivos) === 1 ? 1 : 0 },
      });
    } catch (err: any) {
      reply.code(500).send({ ok: false, message: "Error al listar jugadores", detail: err?.message });
    }
  });

  app.get("/activos", async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = PageQuery.safeParse(req.query);
    const { limit, offset, q } = parsed.success ? parsed.data : { limit: 100, offset: 0, q: undefined };

    try {
      let sql =
        "SELECT id, rut_jugador, nombre_jugador, edad, email, telefono, peso, estatura, " +
        "talla_polera, talla_short, nombre_apoderado, rut_apoderado, telefono_apoderado, " +
        "posicion_id, categoria_id, establec_educ_id, prevision_medica_id, estado_id, " +
        "direccion, comuna_id, " +
        "observaciones, fecha_nacimiento, estadistica_id, sucursal_id, " +
        "foto_mime, foto_updated_at " + // ✅
        "FROM jugadores";

      const args: any[] = [];
      const where: string[] = ["estado_id = 1"];

      if (q) {
        const isNumeric = /^\d+$/.test(q);
        if (isNumeric) {
          where.push("(rut_jugador = ? OR nombre_jugador LIKE ? OR email LIKE ?)");
          args.push(Number(q), `%${q}%`, `%${q}%`);
        } else {
          where.push("(nombre_jugador LIKE ? OR email LIKE ?)");
          args.push(`%${q}%`, `%${q}%`);
        }
      }

      sql += " WHERE " + where.join(" AND ");
      sql += " ORDER BY nombre_jugador ASC, id ASC LIMIT ? OFFSET ?";
      args.push(limit, offset);

      const [rows]: any = await db.query(sql, args);

      reply.send({ ok: true, items: (rows || []).map(normalizeOut), limit, offset, count: rows?.length ?? 0 });
    } catch (err: any) {
      reply.code(500).send({ ok: false, message: "Error al listar jugadores activos", detail: err?.message });
    }
  });

  // ───────── GET por RUT ─────────
  app.get("/rut/:rut", async (req: FastifyRequest, reply: FastifyReply) => {
    const pr = RutParam.safeParse(req.params);
    if (!pr.success) return reply.code(400).send({ ok: false, message: pr.error.issues[0]?.message || "RUT inválido" });

    const rut = pr.data.rut;

    try {
      const [rows]: any = await db.query(
        "SELECT id, rut_jugador, nombre_jugador, edad, email, telefono, peso, estatura, " +
          "talla_polera, talla_short, nombre_apoderado, rut_apoderado, telefono_apoderado, " +
          "posicion_id, categoria_id, establec_educ_id, prevision_medica_id, estado_id, " +
          "observaciones, fecha_nacimiento, estadistica_id, sucursal_id, " +
          "foto_base64, foto_mime, foto_updated_at " + // ✅ aquí sí mando base64 (perfil)
          "FROM jugadores WHERE rut_jugador = ? LIMIT 1",
        [rut]
      );

      if (!rows || rows.length === 0) return reply.code(404).send({ ok: false, message: "No encontrado" });

      reply.send({ ok: true, item: normalizeOut(rows[0]) });
    } catch (err: any) {
      reply.code(500).send({ ok: false, message: "Error al buscar por RUT", detail: err?.message });
    }
  });

  // ───────── GET por ID ─────────
  app.get("/:id", async (req: FastifyRequest, reply: FastifyReply) => {
    const pid = IdParam.safeParse(req.params);
    if (!pid.success) return reply.code(400).send({ ok: false, message: "ID inválido" });

    const id = Number(pid.data.id);

    try {
      const [rows]: any = await db.query(
        "SELECT id, rut_jugador, nombre_jugador, edad, email, telefono, peso, estatura, " +
          "talla_polera, talla_short, nombre_apoderado, rut_apoderado, telefono_apoderado, " +
          "posicion_id, categoria_id, establec_educ_id, prevision_medica_id, estado_id, " +
          "observaciones, fecha_nacimiento, estadistica_id, sucursal_id, " +
          "foto_base64, foto_mime, foto_updated_at " + // ✅
          "FROM jugadores WHERE id = ? LIMIT 1",
        [id]
      );

      if (!rows || rows.length === 0) return reply.code(404).send({ ok: false, message: "No encontrado" });

      reply.send({ ok: true, item: normalizeOut(rows[0]) });
    } catch (err: any) {
      reply.code(500).send({ ok: false, message: "Error al obtener jugador", detail: err?.message });
    }
  });

  // ───────── Crear ─────────
  app.post("/", async (req: FastifyRequest, reply: FastifyReply) => {
    let conn: any = null;
    let mustRelease = false;

    try {
      const parsed = CreateSchema.parse(req.body);
      const data = coerceForDB(pickAllowed(parsed));

      // ✅ Validación foto en creación (opcional, pero consistente)
      if (data.foto_base64 || data.foto_mime) {
        const b64 = cleanBase64Payload(String(data.foto_base64 || ""));
        const mime = String(data.foto_mime || "").toLowerCase();

        if (!mime || !isValidMime(mime)) {
          return reply.code(400).send({ ok: false, message: "foto_mime inválido" });
        }
        if (!b64 || !looksLikeBase64(b64)) {
          return reply.code(400).send({ ok: false, message: "foto_base64 inválido" });
        }

        const bytes = approxBytesFromBase64(b64);
        const MAX_BYTES = 350 * 1024; // 350 KB (ajústalo)
        if (bytes > MAX_BYTES) {
          return reply.code(413).send({ ok: false, message: `Foto excede el máximo (${MAX_BYTES} bytes)` });
        }

        data.foto_base64 = b64;
        data.foto_mime = mime;
        (data as any).foto_updated_at = new Date();
      }

      if ((db as any).getConnection) {
        conn = await (db as any).getConnection();
        mustRelease = true;
      } else {
        conn = db as any;
      }

      // ... (tu lógica actual de duplicados y transacción queda igual)
      // --- lo mantengo tal cual ---
      if (data.rut_jugador != null) {
        const [r]: any = await conn.query("SELECT id FROM jugadores WHERE rut_jugador = ? LIMIT 1", [data.rut_jugador]);
        if (Array.isArray(r) && r.length > 0) {
          return reply.code(409).send({ ok: false, field: "rut_jugador", message: "Duplicado: el RUT ya existe" });
        }
      }

      if (data.email) {
        const [r2]: any = await conn.query("SELECT id FROM jugadores WHERE LOWER(email)=LOWER(?) LIMIT 1", [data.email]);
        if (Array.isArray(r2) && r2.length > 0) {
          return reply.code(409).send({ ok: false, field: "email", message: "Duplicado: el email ya existe" });
        }
      }

      const fkChecks: Array<{ field: string; sql: string; val: any }> = [
        { field: "posicion_id", sql: "SELECT 1 FROM posiciones WHERE id = ? LIMIT 1", val: data.posicion_id },
        { field: "categoria_id", sql: "SELECT 1 FROM categorias WHERE id = ? LIMIT 1", val: data.categoria_id },
        { field: "estado_id", sql: "SELECT 1 FROM estado WHERE id = ? LIMIT 1", val: data.estado_id },
        { field: "establec_educ_id", sql: "SELECT 1 FROM establec_educ WHERE id = ? LIMIT 1", val: data.establec_educ_id },
        { field: "prevision_medica_id", sql: "SELECT 1 FROM prevision_medica WHERE id = ? LIMIT 1", val: data.prevision_medica_id },
        { field: "sucursal_id", sql: "SELECT 1 FROM sucursales_real WHERE id = ? LIMIT 1", val: data.sucursal_id },
        { field: "comuna_id", sql: "SELECT 1 FROM comunas WHERE id = ? LIMIT 1", val: data.comuna_id },
      ];

      for (const fk of fkChecks) {
        if (fk.val != null) {
          const [r]: any = await conn.query(fk.sql, [fk.val]);
          if (!Array.isArray(r) || r.length === 0) {
            return reply.code(409).send({ ok: false, field: fk.field, message: `Violación de clave foránea: ${fk.field} no existe` });
          }
        }
      }

      await conn.beginTransaction();

      const [resJug]: any = await conn.query("INSERT INTO jugadores SET ?", [data]);
      const jugadorId: number = resJug.insertId;

      await conn.query("UPDATE jugadores SET estadistica_id = ? WHERE id = ?", [jugadorId, jugadorId]);

      try {
        await conn.query("INSERT INTO estadisticas (estadistica_id) VALUES (?)", [jugadorId]);
      } catch (e: any) {
        if (e?.errno !== 1062) throw e;
      }

      await conn.commit();

      return reply.code(201).send({
        ok: true,
        id: jugadorId,
        ...normalizeOut({ id: jugadorId, ...data, estadistica_id: jugadorId }),
      });
    } catch (err: any) {
      if (conn) {
        try { await conn.rollback(); } catch {}
      }

      if (err instanceof ZodError) {
        const detail = err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
        return reply.code(400).send({ ok: false, message: "Payload inválido", detail });
      }

      if (err?.errno === 1062) {
        const msg = String(err?.sqlMessage || "").toLowerCase();
        const field = msg.includes("rut_jugador") ? "rut_jugador" : msg.includes("email") ? "email" : undefined;
        return reply.code(409).send({ ok: false, message: field ? `Duplicado: ${field} ya existe` : "Duplicado: clave única violada", field, detail: err?.sqlMessage });
      }

      if (err?.errno === 1452) return reply.code(409).send({ ok: false, message: "Violación de clave foránea (revisa ids enviados)", detail: err?.sqlMessage ?? err?.message });
      if (err?.errno === 1054) return reply.code(500).send({ ok: false, message: "Columna desconocida: revisa el esquema de tablas", detail: err?.sqlMessage ?? err?.message });

      return reply.code(500).send({ ok: false, message: "Error al crear jugador", detail: err?.sqlMessage ?? err?.message });
    } finally {
      if (conn && mustRelease && typeof conn.release === "function") {
        try { conn.release(); } catch {}
      }
    }
  });

  // ───────── PATCH /jugadores/:id ─────────
  app.patch("/:id", async (req: FastifyRequest, reply: FastifyReply) => {
    const pid = IdParam.safeParse(req.params);
    if (!pid.success) return reply.code(400).send({ ok: false, message: "ID inválido" });

    const id = Number(pid.data.id);

    try {
      const parsed = UpdateSchema.parse(req.body);
      const changes = coerceForDB(pickAllowed(parsed));
      delete (changes as any).estadistica_id;

      // ✅ Validación foto si viene
      if ("foto_base64" in changes || "foto_mime" in changes) {
        const b64Raw = changes.foto_base64;
        const mimeRaw = changes.foto_mime;

        // permitir borrar: enviar null en ambos
        const wantsClear =
          (b64Raw === null || b64Raw === undefined || b64Raw === "") &&
          (mimeRaw === null || mimeRaw === undefined || mimeRaw === "");

        if (wantsClear) {
          changes.foto_base64 = null;
          changes.foto_mime = null;
          (changes as any).foto_updated_at = new Date();
        } else {
          const b64 = cleanBase64Payload(String(b64Raw || ""));
          const mime = String(mimeRaw || "").toLowerCase();

          if (!mime || !isValidMime(mime)) {
            return reply.code(400).send({ ok: false, message: "foto_mime inválido" });
          }
          if (!b64 || !looksLikeBase64(b64)) {
            return reply.code(400).send({ ok: false, message: "foto_base64 inválido" });
          }

          const bytes = approxBytesFromBase64(b64);
          const MAX_BYTES = 350 * 1024; // 350 KB (ajústalo)
          if (bytes > MAX_BYTES) {
            return reply.code(413).send({ ok: false, message: `Foto excede el máximo (${MAX_BYTES} bytes)` });
          }

          changes.foto_base64 = b64;
          changes.foto_mime = mime;
          (changes as any).foto_updated_at = new Date();
        }
      }

      if (Object.keys(changes).length === 0) {
        return reply.code(400).send({ ok: false, message: "No hay campos para actualizar" });
      }

      const [result]: any = await db.query("UPDATE jugadores SET ? WHERE id = ?", [changes, id]);

      if (result.affectedRows === 0) return reply.code(404).send({ ok: false, message: "No encontrado" });

      reply.send({ ok: true, updated: { id, ...changes } });
    } catch (err: any) {
      if (err instanceof ZodError) {
        const detail = err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
        return reply.code(400).send({ ok: false, message: "Payload inválido", detail });
      }

      if (err?.errno === 1062) return reply.code(409).send({ ok: false, message: "Duplicado: el RUT (o email) ya existe" });
      if (err?.errno === 1452) return reply.code(409).send({ ok: false, message: "Violación de clave foránea (sucursal_id inválido)", detail: err?.sqlMessage ?? err?.message });

      reply.code(500).send({ ok: false, message: "Error al actualizar jugador", detail: err?.message });
    }
  });

  // ───────── PATCH /jugadores/rut/:rut ─────────
  app.patch("/rut/:rut", async (req: FastifyRequest, reply: FastifyReply) => {
    const pr = RutParam.safeParse(req.params);
    if (!pr.success) return reply.code(400).send({ ok: false, message: pr.error.issues[0]?.message || "RUT inválido" });

    const rut = pr.data.rut;

    try {
      const parsed = UpdateSchema.parse(req.body);
      const changes = coerceForDB(pickAllowed(parsed));
      delete (changes as any).estadistica_id;

      // ✅ Validación foto si viene
      if ("foto_base64" in changes || "foto_mime" in changes) {
        const b64Raw = changes.foto_base64;
        const mimeRaw = changes.foto_mime;

        const wantsClear =
          (b64Raw === null || b64Raw === undefined || b64Raw === "") &&
          (mimeRaw === null || mimeRaw === undefined || mimeRaw === "");

        if (wantsClear) {
          changes.foto_base64 = null;
          changes.foto_mime = null;
          (changes as any).foto_updated_at = new Date();
        } else {
          const b64 = cleanBase64Payload(String(b64Raw || ""));
          const mime = String(mimeRaw || "").toLowerCase();

          if (!mime || !isValidMime(mime)) {
            return reply.code(400).send({ ok: false, message: "foto_mime inválido" });
          }
          if (!b64 || !looksLikeBase64(b64)) {
            return reply.code(400).send({ ok: false, message: "foto_base64 inválido" });
          }

          const bytes = approxBytesFromBase64(b64);
          const MAX_BYTES = 350 * 1024; // 350 KB
          if (bytes > MAX_BYTES) {
            return reply.code(413).send({ ok: false, message: `Foto excede el máximo (${MAX_BYTES} bytes)` });
          }

          changes.foto_base64 = b64;
          changes.foto_mime = mime;
          (changes as any).foto_updated_at = new Date();
        }
      }

      if (Object.keys(changes).length === 0) {
        return reply.code(400).send({ ok: false, message: "No hay campos para actualizar" });
      }

      const [result]: any = await db.query("UPDATE jugadores SET ? WHERE rut_jugador = ?", [changes, rut]);

      if (result.affectedRows === 0) return reply.code(404).send({ ok: false, message: "No encontrado" });

      reply.send({ ok: true, updated: { rut_jugador: rut, ...changes } });
    } catch (err: any) {
      if (err instanceof ZodError) {
        const detail = err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
        return reply.code(400).send({ ok: false, message: "Payload inválido", detail });
      }

      if (err?.errno === 1062) return reply.code(409).send({ ok: false, message: "Duplicado: el RUT (o email) ya existe" });
      if (err?.errno === 1452) return reply.code(409).send({ ok: false, message: "Violación de clave foránea (sucursal_id inválido)", detail: err?.sqlMessage ?? err?.message });

      reply.code(500).send({ ok: false, message: "Error al actualizar jugador por RUT", detail: err?.message });
    }
  });

  // ───────── DELETE ─────────
  app.delete("/:id", async (req: FastifyRequest, reply: FastifyReply) => {
    const pid = IdParam.safeParse(req.params);
    if (!pid.success) return reply.code(400).send({ ok: false, message: "ID inválido" });

    const id = Number(pid.data.id);

    try {
      const [result]: any = await db.query("DELETE FROM jugadores WHERE id = ?", [id]);
      if (result.affectedRows === 0) return reply.code(404).send({ ok: false, message: "No encontrado" });
      reply.send({ ok: true, deleted: id });
    } catch (err: any) {
      if (err?.errno === 1451) {
        return reply.code(409).send({ ok: false, message: "No se puede eliminar: hay referencias asociadas.", detail: err?.sqlMessage ?? err?.message });
      }
      reply.code(500).send({ ok: false, message: "Error al eliminar jugador", detail: err?.message });
    }
  });
}
