import { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../db";
import crypto from "crypto";

/* ───────────────────────────────
   ZOD
─────────────────────────────── */

const CreateTokenSchema = z.object({
  rut_jugador: z.coerce.number().int().positive(),
  rut_apoderado: z.coerce.number().int().positive(),
  email_destino: z.string().email().optional().nullable(),
  ttl_minutes: z.coerce.number().int().positive().max(60 * 24 * 14).optional(), // max 14 días
});

const TokenParam = z.object({
  token: z.string().min(10).max(300), // raw token en URL
});

const FirmarSchema = z.object({
  contrato_base64: z.string().min(10),
  acepta_terminos: z.coerce.boolean().optional().default(true),
});

/* ───────────────────────────────
   UTILS
─────────────────────────────── */

const stripDataUrlPrefix = (s: string) => {
  const idx = s.indexOf(",");
  return s.startsWith("data:") && idx > -1 ? s.slice(idx + 1) : s;
};

const approxBytes = (b64: string) => Math.floor((b64.length * 3) / 4);
const MAX_BYTES = Number(process.env.CONTRATOS_MAX_BYTES || 12 * 1024 * 1024);

// token "raw" para el link
function makeRawToken() {
  return crypto.randomBytes(32).toString("hex"); // 64 chars
}

// hash que se guarda en BD (sha256 hex)
function sha256Hex(input: string) {
  return crypto.createHash("sha256").update(input).digest("hex"); // 64 chars
}

function toMySQLDateTime(d: Date) {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

/* ───────────────────────────────
   ROUTER
─────────────────────────────── */

export default async function contratos_firma_tokens(app: FastifyInstance) {
  // Health
  app.get("/health", async () => ({
    module: "contratos_firma_tokens",
    status: "ready",
    timestamp: new Date().toISOString(),
  }));

  /**
   * POST /contratos-firma-tokens
   * Crea token de firma (recomendado: protegido por auth/admin)
   * Devuelve rawToken (para armar link) + expires_at
   */
  app.post("/", async (req, reply) => {
    const parsed = CreateTokenSchema.safeParse((req as any).body);
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        message: "Payload inválido",
        errors: parsed.error.flatten(),
      });
    }

    const { rut_jugador, rut_apoderado, email_destino } = parsed.data;
    const ttl = parsed.data.ttl_minutes ?? 60 * 24 * 3; // 72h default

    try {
      // checks FK "amables"
      const [[jug]]: any = await db.query(
        `SELECT 1 FROM jugadores WHERE rut_jugador = ? LIMIT 1`,
        [rut_jugador]
      );
      if (!jug) {
        return reply.code(409).send({
          ok: false,
          field: "rut_jugador",
          message: "rut_jugador no existe",
        });
      }

      const [[apo]]: any = await db.query(
        `SELECT 1 FROM jugadores WHERE rut_jugador = ? LIMIT 1`,
        [rut_apoderado]
      );
      if (!apo) {
        return reply.code(409).send({
          ok: false,
          field: "rut_apoderado",
          message: "rut_apoderado no existe",
        });
      }

      const rawToken = makeRawToken();
      const token_hash = sha256Hex(rawToken);

      const createdAt = new Date();
      const expiresAt = addMinutes(createdAt, ttl);

      const created_at = toMySQLDateTime(createdAt);
      const expires_at = toMySQLDateTime(expiresAt);

      await db.query(
        `INSERT INTO contratos_firma_tokens
          (token_hash, rut_jugador, rut_apoderado, email_destino, expires_at, used_at, created_at, ip_created, ip_used)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL)`,
        [
          token_hash,
          rut_jugador,
          rut_apoderado,
          email_destino ?? null,
          expires_at,
          created_at,
          (req as any).ip ?? null,
        ]
      );

      // IMPORTANTE: devolvemos rawToken (para el link), NO el hash
      return reply.code(201).send({
        ok: true,
        token: rawToken,
        rut_jugador,
        rut_apoderado,
        email_destino: email_destino ?? null,
        expires_at,
      });
    } catch (e: any) {
      // por si colisiona el unique (muy raro, pero posible)
      if (e?.errno === 1062) {
        return reply.code(409).send({
          ok: false,
          message: "Colisión de token (intenta nuevamente)",
        });
      }

      return reply.code(500).send({
        ok: false,
        message: "Error al crear token",
        error: e?.message,
      });
    }
  });

  /**
   * GET /contratos-firma-tokens/:token
   * Valida token (público).
   * El cliente manda rawToken, nosotros buscamos por token_hash.
   */
  app.get("/:token", async (req, reply) => {
    const p = TokenParam.safeParse((req as any).params);
    if (!p.success) return reply.code(400).send({ ok: false, message: "Token inválido" });

    const rawToken = p.data.token;
    const token_hash = sha256Hex(rawToken);

    try {
      const [rows]: any = await db.query(
        `SELECT id, rut_jugador, rut_apoderado, email_destino, created_at, expires_at, used_at
           FROM contratos_firma_tokens
          WHERE token_hash = ?
          LIMIT 1`,
        [token_hash]
      );

      if (!rows?.length) return reply.code(404).send({ ok: false, message: "Token no encontrado" });

      const t = rows[0];
      const expired = new Date(t.expires_at).getTime() < Date.now();
      const used = !!t.used_at;

      if (expired) return reply.code(410).send({ ok: false, message: "Token expirado" });
      if (used) return reply.code(409).send({ ok: false, message: "Token ya fue usado" });

      return reply.send({
        ok: true,
        token_valid: true,
        rut_jugador: t.rut_jugador,
        rut_apoderado: t.rut_apoderado,
        email_destino: t.email_destino ?? null,
        expires_at: t.expires_at,
      });
    } catch (e: any) {
      return reply.code(500).send({
        ok: false,
        message: "Error al validar token",
        error: e?.message,
      });
    }
  });

  /**
   * POST /contratos-firma-tokens/:token/firmar
   * Consume token y guarda contrato en contratos_jugadores.
   * Marca used_at para que no se reutilice.
   */
  app.post("/:token/firmar", async (req, reply) => {
    const p = TokenParam.safeParse((req as any).params);
    if (!p.success) return reply.code(400).send({ ok: false, message: "Token inválido" });

    const b = FirmarSchema.safeParse((req as any).body);
    if (!b.success) {
      return reply.code(400).send({
        ok: false,
        message: "Payload inválido",
        errors: b.error.flatten(),
      });
    }

    if (!b.data.acepta_terminos) {
      return reply.code(400).send({
        ok: false,
        message: "Debes aceptar los términos para firmar.",
      });
    }

    const rawToken = p.data.token;
    const token_hash = sha256Hex(rawToken);

    const pure = stripDataUrlPrefix(b.data.contrato_base64);
    const bytes = approxBytes(pure);

    if (bytes > MAX_BYTES) {
      return reply.code(413).send({
        ok: false,
        message: `El PDF excede el límite permitido (${Math.floor(MAX_BYTES / (1024 * 1024))} MB).`,
      });
    }

    let conn: any = null;
    let mustRelease = false;

    try {
      if ((db as any).getConnection) {
        conn = await (db as any).getConnection();
        mustRelease = true;
      } else {
        conn = db as any;
      }

      await conn.beginTransaction();

      // Bloqueo para evitar doble firma
      const [rows]: any = await conn.query(
        `SELECT id, rut_jugador, rut_apoderado, expires_at, used_at
           FROM contratos_firma_tokens
          WHERE token_hash = ?
          LIMIT 1
          FOR UPDATE`,
        [token_hash]
      );

      if (!rows?.length) {
        await conn.rollback();
        return reply.code(404).send({ ok: false, message: "Token no encontrado" });
      }

      const t = rows[0];
      const expired = new Date(t.expires_at).getTime() < Date.now();
      const used = !!t.used_at;

      if (expired) {
        await conn.rollback();
        return reply.code(410).send({ ok: false, message: "Token expirado" });
      }
      if (used) {
        await conn.rollback();
        return reply.code(409).send({ ok: false, message: "Token ya fue usado" });
      }

      // Inserta contrato firmado
      const [ins]: any = await conn.query(
        `INSERT INTO contratos_jugadores
          (rut_jugador, rut_apoderado, fecha_generacion, contrato_base64)
         VALUES (?, ?, NOW(), ?)`,
        [t.rut_jugador, t.rut_apoderado, pure]
      );

      // Marca token como usado
      await conn.query(
        `UPDATE contratos_firma_tokens
            SET used_at = NOW(), ip_used = ?
          WHERE id = ?`,
        [(req as any).ip ?? null, t.id]
      );

      await conn.commit();

      return reply.code(201).send({
        ok: true,
        contrato_id: ins.insertId,
        rut_jugador: t.rut_jugador,
        rut_apoderado: t.rut_apoderado,
        used_at: toMySQLDateTime(new Date()),
      });
    } catch (e: any) {
      if (conn) {
        try { await conn.rollback(); } catch {}
      }

      if (e?.errno === 1452) {
        return reply.code(409).send({
          ok: false,
          message: "Violación de clave foránea (ruts inválidos)",
          detail: e?.sqlMessage ?? e?.message,
        });
      }

      return reply.code(500).send({
        ok: false,
        message: "Error al firmar/guardar contrato",
        error: e?.message,
      });
    } finally {
      if (conn && mustRelease && typeof conn.release === "function") {
        try { conn.release(); } catch {}
      }
    }
  });
}
