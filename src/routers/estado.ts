// src/routers/estado.ts
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { db } from '../db';

/**
 * Tabla: estado
 * Campos: id (PK), nombre (VARCHAR UNIQUE)
 */

const IdParam = z.object({
  id: z.string().regex(/^\d+$/)
});

const CreateSchema = z.object({
  nombre: z.string().trim().min(2, 'Debe tener al menos 2 caracteres')
}).strict();

const UpdateSchema = z.object({
  nombre: z.string().trim().min(2, 'Debe tener al menos 2 caracteres').optional()
}).strict();

// Normalización mínima
function normalize(row: any) {
  return {
    id: Number(row.id),
    nombre: String(row.nombre ?? '')
  };
}

export default async function estado(app: FastifyInstance) {

  // ───────────────────────────── Health ─────────────────────────────
  app.get('/health', async () => ({
    module: 'estado',
    status: 'ready',
    timestamp: new Date().toISOString()
  }));

  // ───────────────────────────── GET all ─────────────────────────────
  app.get('/', async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      const [rows]: any = await db.query(
        'SELECT id, nombre FROM estado ORDER BY id ASC'
      );

      return reply.send({
        ok: true,
        count: rows.length,
        items: rows.map(normalize)
      });

    } catch (err: any) {
      return reply.code(500).send({
        ok: false,
        message: 'Error al listar estados',
        error: err?.message
      });
    }
  });

  // ───────────────────────────── GET by ID ─────────────────────────────
  app.get('/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = IdParam.safeParse(req.params);
    if (!parsed.success)
      return reply.code(400).send({ ok: false, message: 'ID inválido' });

    const id = Number(parsed.data.id);

    try {
      const [rows]: any = await db.query(
        'SELECT id, nombre FROM estado WHERE id = ? LIMIT 1',
        [id]
      );

      if (!rows.length) {
        return reply.code(404).send({
          ok: false,
          message: 'Estado no encontrado'
        });
      }

      return reply.send({
        ok: true,
        item: normalize(rows[0])
      });

    } catch (err: any) {
      return reply.code(500).send({
        ok: false,
        message: 'Error al obtener estado',
        error: err?.message
      });
    }
  });

  // ───────────────────────────── POST (create) ─────────────────────────────
  app.post('/', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const parsed = CreateSchema.parse(req.body);
      const nombre = parsed.nombre.trim();

      const [result]: any = await db.query(
        'INSERT INTO estado (nombre) VALUES (?)',
        [nombre]
      );

      return reply.code(201).send({
        ok: true,
        id: result.insertId,
        nombre
      });

    } catch (err: any) {
      if (err instanceof ZodError) {
        const issues = err.issues.map(i => `${i.path}: ${i.message}`).join('; ');
        return reply.code(400).send({ ok: false, message: issues });
      }

      if (err?.errno === 1062) {
        return reply.code(409).send({
          ok: false,
          message: 'El estado ya existe'
        });
      }

      return reply.code(500).send({
        ok: false,
        message: 'Error al crear estado',
        error: err?.message
      });
    }
  });

  // ───────────────────────────── PUT (update) ─────────────────────────────
  app.put('/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsedID = IdParam.safeParse(req.params);
    if (!parsedID.success) {
      return reply.code(400).send({ ok: false, message: 'ID inválido' });
    }
    const id = Number(parsedID.data.id);

    try {
      const parsedBody = UpdateSchema.parse(req.body);
      const updates = parsedBody;

      if (!Object.keys(updates).length) {
        return reply.code(400).send({ ok: false, message: 'No hay campos para actualizar' });
      }

      const [result]: any = await db.query(
        'UPDATE estado SET ? WHERE id = ?',
        [updates, id]
      );

      if (result.affectedRows === 0) {
        return reply.code(404).send({ ok: false, message: 'No encontrado' });
      }

      return reply.send({
        ok: true,
        updated: { id, ...updates }
      });

    } catch (err: any) {
      if (err instanceof ZodError) {
        const issues = err.issues.map(i => `${i.path}: ${i.message}`).join('; ');
        return reply.code(400).send({ ok: false, message: issues });
      }

      if (err?.errno === 1062) {
        return reply.code(409).send({
          ok: false,
          message: 'El estado ya existe'
        });
      }

      return reply.code(500).send({
        ok: false,
        message: 'Error al actualizar estado',
        error: err?.message
      });
    }
  });

  // ───────────────────────────── DELETE ─────────────────────────────
  app.delete('/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = IdParam.safeParse(req.params);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, message: 'ID inválido' });
    }

    const id = Number(parsed.data.id);

    try {
      const [result]: any = await db.query(
        'DELETE FROM estado WHERE id = ?',
        [id]
      );

      if (result.affectedRows === 0) {
        return reply.code(404).send({ ok: false, message: 'No encontrado' });
      }

      return reply.send({
        ok: true,
        deleted: id
      });

    } catch (err: any) {
      return reply.code(500).send({
        ok: false,
        message: 'Error al eliminar estado',
        error: err?.message
      });
    }
  });

}
