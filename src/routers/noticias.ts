import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { getDb } from "../db";

const SlugSchema = z.object({ slug: z.string().min(1).max(160) });
const IdSchema = z.object({ id: z.coerce.number().int().positive() });

const NOW_SQL = `NOW()`;

const ESTADO_PUBLICADA = 2;

export default async function noticias(app: FastifyInstance, _opts: FastifyPluginOptions) {
  // GET /api/noticias/landing
  app.get("/landing", async (_req, reply) => {
    const db = getDb();

    const [popupRows] = await db.query<any[]>(
      `
      SELECT id, slug, titulo, resumen,
             imagen_mime, imagen_bytes,
             published_at,
             popup_start_at, popup_end_at
      FROM noticias
      WHERE estado_noticia_id = ?
        AND is_popup = 1
        AND (popup_start_at IS NULL OR popup_start_at <= ${NOW_SQL})
        AND (popup_end_at   IS NULL OR popup_end_at   >= ${NOW_SQL})
      ORDER BY published_at DESC, updated_at DESC
      LIMIT 1
      `,
      [ESTADO_PUBLICADA]
    );

    const [cardRows] = await db.query<any[]>(
      `
      SELECT id, slug, titulo, resumen,
             imagen_mime, imagen_bytes,
             published_at, pinned, pinned_order
      FROM noticias
      WHERE estado_noticia_id = ?
      ORDER BY pinned DESC,
               pinned_order IS NULL, pinned_order ASC,
               published_at DESC, updated_at DESC
      LIMIT 6
      `,
      [ESTADO_PUBLICADA]
    );

    return reply.send({ ok: true, popup: popupRows?.[0] ?? null, cards: cardRows ?? [] });
  });

  // GET /api/noticias/slug/:slug
  app.get("/slug/:slug", async (req, reply) => {
    const parsed = SlugSchema.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: "BAD_REQUEST" });

    const db = getDb();
    const [rows] = await db.query<any[]>(
      `
      SELECT id, slug, titulo, resumen, contenido,
             imagen_mime, imagen_bytes,
             estado_noticia_id, published_at,
             is_popup, popup_start_at, popup_end_at,
             pinned, pinned_order,
             created_at, updated_at
      FROM noticias
      WHERE slug = ?
      LIMIT 1
      `,
      [parsed.data.slug]
    );

    if (!rows?.length) return reply.code(404).send({ ok: false, message: "NOT_FOUND" });

    const item = rows[0];
    if (Number(item.estado_noticia_id) !== ESTADO_PUBLICADA) {
      return reply.code(404).send({ ok: false, message: "NOT_FOUND" });
    }

    return reply.send({ ok: true, item });
  });

  // GET /api/noticias/:id/imagen
  app.get("/:id/imagen", async (req, reply) => {
    const parsed = IdSchema.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: "BAD_REQUEST" });

    const db = getDb();
    const [rows] = await db.query<any[]>(
      `
      SELECT imagen_mime, imagen_base64
      FROM noticias
      WHERE id = ? AND estado_noticia_id = ?
      LIMIT 1
      `,
      [parsed.data.id, ESTADO_PUBLICADA]
    );

    if (!rows?.length) return reply.code(404).send({ ok: false, message: "NOT_FOUND" });

    const it = rows[0];
    if (!it?.imagen_base64 || !it?.imagen_mime) {
      return reply.send({ ok: true, imagen_mime: null, imagen_base64: null });
    }

    return reply.send({ ok: true, imagen_mime: it.imagen_mime, imagen_base64: it.imagen_base64 });
  });
}
