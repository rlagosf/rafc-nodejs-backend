// src/routers/comunas.ts
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { db } from '../db';

/* ───────── Schemas ───────── */

const IdParam = z.object({
  id: z.string().regex(/^\d+$/, 'ID inválido'),
});

const CreateSchema = z.object({
  nombre: z.string().trim().min(1, 'El nombre es obligatorio'),
}).strict();

const UpdateSchema = z.object({
  nombre: z.string().trim().min(1).optional(),
}).strict();

/* ───────── Helpers ───────── */

function normalizeOut(row: any) {
  if (!row) return null;
  return {
    id: Number(row.id),
    nombre: String(row.nombre ?? ''),
  };
}

/* ───────── Router ───────── */

export default async function comunas(app: FastifyInstance) {

  app.get('/health', async () => ({
    module: 'comunas',
    status: 'ready',
    timestamp: new Date().toISOString(),
  }));

  // ───────── GET /comunas ─────────
  app.get('/', async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      const [rows]: any = await db.query(
        'SELECT id, nombre FROM comunas ORDER BY nombre ASC'
      );

      reply.send({
        ok: true,
        items: (rows || []).map(normalizeOut),
        count: rows?.length ?? 0,
      });
    } catch (err: any) {
      reply.code(500).send({
        ok: false,
        message: 'Error al listar comunas',
        detail: err?.message,
      });
    }
  });

  // ───────── GET /comunas/:id ─────────
  app.get('/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const pid = IdParam.safeParse(req.params);
    if (!pid.success) {
      return reply.code(400).send({
        ok: false,
        message: pid.error.issues[0]?.message,
      });
    }

    const id = Number(pid.data.id);

    try {
      const [rows]: any = await db.query(
        'SELECT id, nombre FROM comunas WHERE id = ? LIMIT 1',
        [id]
      );

      if (!rows || rows.length === 0) {
        return reply.code(404).send({ ok: false, message: 'No encontrado' });
      }

      reply.send({ ok: true, item: normalizeOut(rows[0]) });
    } catch (err: any) {
      reply.code(500).send({
        ok: false,
        message: 'Error al obtener comuna',
        detail: err?.message,
      });
    }
  });

  // ───────── POST /comunas ─────────
  app.post('/', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const parsed = CreateSchema.parse(req.body);

      // Evita duplicados por nombre
      const [exists]: any = await db.query(
        'SELECT id FROM comunas WHERE LOWER(nombre) = LOWER(?) LIMIT 1',
        [parsed.nombre]
      );

      if (Array.isArray(exists) && exists.length > 0) {
        return reply.code(409).send({
          ok: false,
          field: 'nombre',
          message: 'Duplicado: la comuna ya existe',
        });
      }

      const [result]: any = await db.query(
        'INSERT INTO comunas (nombre) VALUES (?)',
        [parsed.nombre.trim()]
      );

      reply.code(201).send({
        ok: true,
        id: result.insertId,
        item: { id: result.insertId, nombre: parsed.nombre.trim() },
      });
    } catch (err: any) {
      if (err instanceof ZodError) {
        return reply.code(400).send({
          ok: false,
          message: 'Payload inválido',
          detail: err.issues.map(i => i.message).join('; '),
        });
      }

      if (err?.errno === 1062) {
        return reply.code(409).send({
          ok: false,
          message: 'Duplicado: la comuna ya existe',
        });
      }

      reply.code(500).send({
        ok: false,
        message: 'Error al crear comuna',
        detail: err?.message,
      });
    }
  });

  // ───────── PATCH /comunas/:id ─────────
  app.patch('/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const pid = IdParam.safeParse(req.params);
    if (!pid.success) {
      return reply.code(400).send({
        ok: false,
        message: pid.error.issues[0]?.message,
      });
    }

    try {
      const parsed = UpdateSchema.parse(req.body);
      if (!parsed.nombre) {
        return reply.code(400).send({
          ok: false,
          message: 'No hay campos para actualizar',
        });
      }

      const [result]: any = await db.query(
        'UPDATE comunas SET nombre = ? WHERE id = ?',
        [parsed.nombre.trim(), Number(pid.data.id)]
      );

      if (result.affectedRows === 0) {
        return reply.code(404).send({ ok: false, message: 'No encontrado' });
      }

      reply.send({
        ok: true,
        updated: { id: Number(pid.data.id), nombre: parsed.nombre.trim() },
      });
    } catch (err: any) {
      if (err instanceof ZodError) {
        return reply.code(400).send({
          ok: false,
          message: 'Payload inválido',
          detail: err.issues.map(i => i.message).join('; '),
        });
      }

      reply.code(500).send({
        ok: false,
        message: 'Error al actualizar comuna',
        detail: err?.message,
      });
    }
  });

  // ───────── DELETE /comunas/:id ─────────
  app.delete('/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const pid = IdParam.safeParse(req.params);
    if (!pid.success) {
      return reply.code(400).send({
        ok: false,
        message: pid.error.issues[0]?.message,
      });
    }

    try {
      const [result]: any = await db.query(
        'DELETE FROM comunas WHERE id = ?',
        [Number(pid.data.id)]
      );

      if (result.affectedRows === 0) {
        return reply.code(404).send({ ok: false, message: 'No encontrado' });
      }

      reply.send({ ok: true, deleted: Number(pid.data.id) });
    } catch (err: any) {
      if (err?.errno === 1451) {
        return reply.code(409).send({
          ok: false,
          message: 'No se puede eliminar: hay jugadores asociados a esta comuna',
          detail: err?.sqlMessage ?? err?.message,
        });
      }

      reply.code(500).send({
        ok: false,
        message: 'Error al eliminar comuna',
        detail: err?.message,
      });
    }
  });
}
