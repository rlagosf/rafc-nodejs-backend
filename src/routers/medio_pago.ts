// src/routers/medio_pago.ts
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z, ZodError } from 'zod';
import { db } from '../db';

/**
 * Tabla: medio_pago
 * Campos: id (PK), nombre (VARCHAR UNIQUE)
 */

const IdParam = z.object({
  id: z.string().regex(/^\d+$/),
});

const CreateSchema = z.object({
  nombre: z.string().trim().min(2, 'Debe tener al menos 2 caracteres'),
}).strict();

const UpdateSchema = z.object({
  nombre: z.string().trim().min(2, 'Debe tener al menos 2 caracteres').optional(),
}).strict();

// Normalización de salida
function normalize(row: any) {
  return {
    id: Number(row.id),
    nombre: String(row.nombre ?? ''),
  };
}

export default async function medio_pago(app: FastifyInstance) {
  // ───────────────────── Health ─────────────────────
  app.get('/health', async () => ({
    module: 'medio_pago',
    status: 'ready',
    timestamp: new Date().toISOString(),
  }));

  // ───────────────────── GET todos ─────────────────────
  app.get('/', async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      const [rows]: any = await db.query(
        'SELECT id, nombre FROM medio_pago ORDER BY id ASC'
      );

      return reply.send({
        ok: true,
        count: rows.length,
        items: rows.map(normalize),
      });
    } catch (err: any) {
      return reply.code(500).send({
        ok: false,
        message: 'Error al listar medio_pago',
        error: err?.message,
      });
    }
  });

  // ───────────────────── GET por ID ─────────────────────
  app.get('/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = IdParam.safeParse(req.params);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, message: 'ID inválido' });
    }

    const id = Number(parsed.data.id);

    try {
      const [rows]: any = await db.query(
        'SELECT id, nombre FROM medio_pago WHERE id = ? LIMIT 1',
        [id]
      );

      if (!rows?.length) {
        return reply.code(404).send({
          ok: false,
          message: 'Medio de pago no encontrado',
        });
      }

      return reply.send({
        ok: true,
        item: normalize(rows[0]),
      });
    } catch (err: any) {
      return reply.code(500).send({
        ok: false,
        message: 'Error al obtener medio_pago',
        error: err?.message,
      });
    }
  });

  // ───────────────────── POST (crear) ─────────────────────
  app.post('/', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const parsed = CreateSchema.parse(req.body);
      const nombre = parsed.nombre.trim();

      const [result]: any = await db.query(
        'INSERT INTO medio_pago (nombre) VALUES (?)',
        [nombre]
      );

      return reply.code(201).send({
        ok: true,
        id: result.insertId,
        nombre,
      });
    } catch (err: any) {
      if (err instanceof ZodError) {
        const detail = err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
        return reply.code(400).send({ ok: false, message: 'Payload inválido', detail });
      }

      if (err?.errno === 1062) {
        return reply.code(409).send({
          ok: false,
          message: 'El medio de pago ya existe',
        });
      }

      return reply.code(500).send({
        ok: false,
        message: 'Error al crear medio_pago',
        error: err?.message,
      });
    }
  });

  // ───────────────────── PUT (actualizar) ─────────────────────
  app.put('/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const pid = IdParam.safeParse(req.params);
    if (!pid.success) {
      return reply.code(400).send({ ok: false, message: 'ID inválido' });
    }
    const id = Number(pid.data.id);

    try {
      const parsed = UpdateSchema.parse(req.body);
      const changes = parsed;

      if (Object.keys(changes).length === 0) {
        return reply.code(400).send({
          ok: false,
          message: 'No hay campos para actualizar',
        });
      }

      const [result]: any = await db.query(
        'UPDATE medio_pago SET ? WHERE id = ?',
        [changes, id]
      );

      if (result.affectedRows === 0) {
        return reply.code(404).send({ ok: false, message: 'No encontrado' });
      }

      return reply.send({
        ok: true,
        updated: { id, ...changes },
      });
    } catch (err: any) {
      if (err instanceof ZodError) {
        const detail = err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
        return reply.code(400).send({ ok: false, message: 'Payload inválido', detail });
      }

      if (err?.errno === 1062) {
        return reply.code(409).send({
          ok: false,
          message: 'El medio de pago ya existe',
        });
      }

      return reply.code(500).send({
        ok: false,
        message: 'Error al actualizar medio_pago',
        error: err?.message,
      });
    }
  });

  // ───────────────────── DELETE ─────────────────────
  app.delete('/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = IdParam.safeParse(req.params);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, message: 'ID inválido' });
    }

    const id = Number(parsed.data.id);

    try {
      const [result]: any = await db.query(
        'DELETE FROM medio_pago WHERE id = ?',
        [id]
      );

      if (result.affectedRows === 0) {
        return reply.code(404).send({ ok: false, message: 'No encontrado' });
      }

      return reply.send({
        ok: true,
        deleted: id,
      });
    } catch (err: any) {
      return reply.code(500).send({
        ok: false,
        message: 'Error al eliminar medio_pago',
        error: err?.message,
      });
    }
  });
}
