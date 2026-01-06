// src/routers/noticias_public.ts
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getDb } from "../db";

/**
 * Estado noticias (tu regla real):
 * 1 = Borrador
 * 2 = Publicada
 * 3 = Archivada
 */
const ESTADO_PUBLICADA_ID = 2;

export async function noticiasPublicRoutes(app: FastifyInstance) {
  // GET /api/noticias -> { popup, cards }
  app.get("/", async (req, reply) => {
    const db = getDb();

    try {
      // Popup: publicada + is_popup=1 y ventana válida si existe
      const [popupRows]: any = await db.query(
        `
        SELECT id, slug, titulo, resumen, published_at
        FROM noticias
        WHERE estado_noticia_id = ?
          AND is_popup = 1
          AND (popup_start_at IS NULL OR popup_start_at <= NOW())
          AND (popup_end_at   IS NULL OR popup_end_at   >= NOW())
        ORDER BY published_at DESC
        LIMIT 1
        `,
        [ESTADO_PUBLICADA_ID]
      );

      const popup = popupRows?.[0] ?? null;
      const popupId = popup?.id ?? null;

      // Cards: publicadas, excluye popup, con pinned
      const [cards]: any = await db.query(
        `
        SELECT id, slug, titulo, resumen, published_at
        FROM noticias
        WHERE estado_noticia_id = ?
          AND (? IS NULL OR id <> ?)
        ORDER BY
          pinned DESC,
          COALESCE(pinned_order, 999999) ASC,
          published_at DESC
        LIMIT 6
        `,
        [ESTADO_PUBLICADA_ID, popupId, popupId]
      );

      return { popup, cards: cards ?? [] };
    } catch (err: any) {
      req.log.error({ err }, "[noticias_public] Error GET /api/noticias");
      return reply.code(500).send({ ok: false, message: "Error interno (noticias)" });
    }
  });

  // GET /api/noticias/:id -> { ok, item }
  app.get("/:id", async (req, reply) => {
    const { id } = z
      .object({ id: z.coerce.number().int().positive() })
      .parse(req.params);

    const db = getDb();

    try {
      const [rows]: any = await db.query(
        `
        SELECT id, slug, titulo, resumen, contenido, published_at,
               imagen_mime, imagen_base64, imagen_bytes
        FROM noticias
        WHERE id = ?
          AND estado_noticia_id = ?
        LIMIT 1
        `,
        [id, ESTADO_PUBLICADA_ID]
      );

      const item = rows?.[0];
      if (!item) return reply.code(404).send({ ok: false, message: "Not found" });

      return { ok: true, item };
    } catch (err: any) {
      req.log.error({ err }, "[noticias_public] Error GET /api/noticias/:id");
      return reply.code(500).send({ ok: false, message: "Error interno (noticia)" });
    }
  });
}
