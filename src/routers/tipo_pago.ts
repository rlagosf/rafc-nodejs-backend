// src/routers/tipo_pago.ts
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db } from '../db';

/**
 * Tabla: tipo_pago
 * Campos: id (PK), nombre (VARCHAR)
 * Catálogo de tipos de pago (administrable vía CRUD)
 */

const IdParam = z.object({
  id: z.coerce.number().int().positive(),
});

const CreateSchema = z.object({
  nombre: z.string().trim().min(3, 'El nombre debe tener al menos 3 caracteres'),
});

const UpdateSchema = z.object({
  nombre: z.string().trim().min(3, 'El nombre debe tener al menos 3 caracteres').optional(),
});

const allowedKeys = new Set(['nombre']);

function pickAllowed(body: Record<string, any>) {
  const out: Record<string, any> = {};
  for (const k in body) if (allowedKeys.has(k)) out[k] = body[k];
  return out;
}

function normalize(row: any) {
  return {
    id: Number(row.id),
    nombre: String(row.nombre ?? ''),
  };
}

export default async function tipo_pago(app: FastifyInstance) {
  // Healthcheck
  app.get('/health', async () => ({
    module: 'tipo_pago',
    status: 'ready',
    timestamp: new Date().toISOString(),
  }));

  // GET /tipo-pago  -> lista todos los tipos de pago
  app.get('/', async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      const [rows]: any = await db.query(
        'SELECT id, nombre FROM tipo_pago ORDER BY id ASC'
      );

      return reply.send({
        ok: true,
        count: rows.length,
        items: rows.map(normalize),
      });
    } catch (err: any) {
      return reply.code(500).send({
        ok: false,
        message: 'Error al listar tipo_pago',
        error: err?.message,
      });
    }
  });

  // GET /tipo-pago/:id  -> obtiene un tipo de pago por id
  app.get('/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = IdParam.safeParse((req as any).params);
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        message: 'ID inválido',
      });
    }

    const id = parsed.data.id;

    try {
      const [rows]: any = await db.query(
        'SELECT id, nombre FROM tipo_pago WHERE id = ? LIMIT 1',
        [id]
      );

      if (!rows || rows.length === 0) {
        return reply.code(404).send({
          ok: false,
          message: 'Tipo de pago no encontrado',
        });
      }

      return reply.send({
        ok: true,
        item: normalize(rows[0]),
      });
    } catch (err: any) {
      return reply.code(500).send({
        ok: false,
        message: 'Error al obtener tipo_pago',
        error: err?.message,
      });
    }
  });

  // POST /tipo-pago  -> crear nuevo tipo de pago
  app.post('/', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = CreateSchema.safeParse((req as any).body);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map(iss => `${iss.path.join('.')}: ${iss.message}`)
        .join('; ');
      return reply.code(400).send({
        ok: false,
        message: 'Datos inválidos',
        detail,
      });
    }

    const data = pickAllowed(parsed.data);

    try {
      const [result]: any = await db.query(
        'INSERT INTO tipo_pago SET ?',
        [data]
      );

      return reply.code(201).send({
        ok: true,
        id: result.insertId,
        ...data,
      });
    } catch (err: any) {
      if (err?.errno === 1062) {
        return reply.code(409).send({
          ok: false,
          message: 'Ya existe un tipo de pago con ese nombre',
        });
      }

      return reply.code(500).send({
        ok: false,
        message: 'Error al crear tipo_pago',
        error: err?.message,
      });
    }
  });

  // PUT /tipo-pago/:id  -> actualizar tipo de pago
  app.put('/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const p = IdParam.safeParse((req as any).params);
    if (!p.success) {
      return reply.code(400).send({
        ok: false,
        message: 'ID inválido',
      });
    }
    const id = p.data.id;

    const parsed = UpdateSchema.safeParse((req as any).body);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map(iss => `${iss.path.join('.')}: ${iss.message}`)
        .join('; ');
      return reply.code(400).send({
        ok: false,
        message: 'Datos inválidos',
        detail,
      });
    }

    const changes = pickAllowed(parsed.data);
    if (Object.keys(changes).length === 0) {
      return reply.code(400).send({
        ok: false,
        message: 'No hay campos para actualizar',
      });
    }

    try {
      const [result]: any = await db.query(
        'UPDATE tipo_pago SET ? WHERE id = ?',
        [changes, id]
      );

      if (result.affectedRows === 0) {
        return reply.code(404).send({
          ok: false,
          message: 'Tipo de pago no encontrado',
        });
      }

      return reply.send({
        ok: true,
        updated: { id, ...changes },
      });
    } catch (err: any) {
      if (err?.errno === 1062) {
        return reply.code(409).send({
          ok: false,
          message: 'Ya existe un tipo de pago con ese nombre',
        });
      }

      return reply.code(500).send({
        ok: false,
        message: 'Error al actualizar tipo_pago',
        error: err?.message,
      });
    }
  });

  // DELETE /tipo-pago/:id  -> eliminar tipo de pago
  app.delete('/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const p = IdParam.safeParse((req as any).params);
    if (!p.success) {
      return reply.code(400).send({
        ok: false,
        message: 'ID inválido',
      });
    }
    const id = p.data.id;

    try {
      const [result]: any = await db.query(
        'DELETE FROM tipo_pago WHERE id = ?',
        [id]
      );

      if (result.affectedRows === 0) {
        return reply.code(404).send({
          ok: false,
          message: 'Tipo de pago no encontrado',
        });
      }

      return reply.send({ ok: true, deleted: id });
    } catch (err: any) {
      // Si más adelante le pones FK desde pagos_jugador, acá podrías capturar errno 1451
      return reply.code(500).send({
        ok: false,
        message: 'Error al eliminar tipo_pago',
        error: err?.message,
      });
    }
  });
}
