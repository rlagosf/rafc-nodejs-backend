// src/routers/sucursalesReal.ts
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { db } from '../db';

// Tabla: sucursales_real (id, nombre)

const IdParam = z.object({ id: z.string().regex(/^\d+$/) });

const CreateSchema = z.object({
  nombre: z.string().trim().min(3, 'Debe tener al menos 3 caracteres'),
}).strict();

const UpdateSchema = z.object({
  nombre: z.string().trim().min(3, 'Debe tener al menos 3 caracteres').optional(),
}).strict();

const PageQuery = z.object({
  limit: z.coerce.number().int().positive().max(500).optional().default(200),
  offset: z.coerce.number().int().nonnegative().optional().default(0),
  q: z.string().trim().min(1).optional(), // búsqueda por nombre (opcional)
});

const allowedKeys = new Set(['nombre']);

function pickAllowed(body: Record<string, any>) {
  const out: Record<string, any> = {};
  for (const k in body) if (allowedKeys.has(k)) out[k] = body[k];
  return out;
}

// Normalización/seguridad mínima
function normalizeRow(row: any) {
  return {
    id: Number(row?.id),
    nombre: String(row?.nombre ?? ''),
  };
}

export default async function sucursales_real(app: FastifyInstance) {
  // Health
  app.get('/health', async () => ({
    module: 'sucursales_real',
    status: 'ready',
    timestamp: new Date().toISOString(),
  }));

  // GET /sucursales-real?limit&offset[&q]
  app.get('/', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = PageQuery.safeParse((req as any).query);
    const { limit, offset, q } = parsed.success ? parsed.data : { limit: 200, offset: 0, q: undefined };

    try {
      let sql = 'SELECT id, nombre FROM sucursales_real';
      const args: any[] = [];

      if (q) {
        sql += ' WHERE nombre LIKE ?';
        args.push(`%${q}%`);
      }

      sql += ' ORDER BY nombre ASC, id ASC LIMIT ? OFFSET ?';
      args.push(limit, offset);

      const [rows]: any = await db.query(sql, args);
      reply.send({ ok: true, items: (rows || []).map(normalizeRow), limit, offset, count: rows?.length ?? 0 });
    } catch (err: any) {
      reply.code(500).send({ ok: false, message: 'Error al listar sucursales', detail: err?.message });
    }
  });

  // GET /sucursales-real/:id
  app.get('/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = IdParam.safeParse((req as any).params);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: 'ID inválido' });
    const id = Number(parsed.data.id);

    try {
      const [rows]: any = await db.query('SELECT id, nombre FROM sucursales_real WHERE id = ? LIMIT 1', [id]);
      if (!rows || rows.length === 0) return reply.code(404).send({ ok: false, message: 'No encontrado' });
      reply.send({ ok: true, item: normalizeRow(rows[0]) });
    } catch (err: any) {
      reply.code(500).send({ ok: false, message: 'Error al obtener sucursal', detail: err?.message });
    }
  });

  // POST /sucursales-real
  app.post('/', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const parsed = CreateSchema.parse((req as any).body);
      const data = pickAllowed(parsed);

      const [result]: any = await db.query('INSERT INTO sucursales_real SET ?', [data]);
      reply.code(201).send({ ok: true, id: result.insertId, ...data });
    } catch (err: any) {
      if (err instanceof ZodError) {
        const detail = err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
        return reply.code(400).send({ ok: false, message: 'Payload inválido', detail });
      }
      if (err?.errno === 1062) {
        return reply.code(409).send({ ok: false, message: 'Nombre de sucursal ya existe' });
      }
      reply.code(500).send({ ok: false, message: 'Error al crear sucursal', detail: err?.message });
    }
  });

  // PUT /sucursales-real/:id
  app.put('/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const pid = IdParam.safeParse((req as any).params);
    if (!pid.success) return reply.code(400).send({ ok: false, message: 'ID inválido' });
    const id = Number(pid.data.id);

    try {
      const parsed = UpdateSchema.parse((req as any).body);
      const changes = pickAllowed(parsed);

      if (Object.keys(changes).length === 0) {
        return reply.code(400).send({ ok: false, message: 'No hay campos para actualizar' });
      }

      const [result]: any = await db.query('UPDATE sucursales_real SET ? WHERE id = ?', [changes, id]);
      if (result.affectedRows === 0) return reply.code(404).send({ ok: false, message: 'No encontrado' });
      reply.send({ ok: true, updated: { id, ...changes } });
    } catch (err: any) {
      if (err instanceof ZodError) {
        const detail = err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
        return reply.code(400).send({ ok: false, message: 'Payload inválido', detail });
      }
      if (err?.errno === 1062) {
        return reply.code(409).send({ ok: false, message: 'Nombre de sucursal ya existe' });
      }
      reply.code(500).send({ ok: false, message: 'Error al actualizar sucursal', detail: err?.message });
    }
  });

  // DELETE /sucursales-real/:id
  app.delete('/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = IdParam.safeParse((req as any).params);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: 'ID inválido' });
    const id = Number(parsed.data.id);

    try {
      // Si hay FK (jugadores.sucursal_id -> sucursales_real.id con ON DELETE SET NULL),
      // la eliminación es segura. Si tienes RESTRICT, esto fallará y se captura abajo.
      const [result]: any = await db.query('DELETE FROM sucursales_real WHERE id = ?', [id]);
      if (result.affectedRows === 0) return reply.code(404).send({ ok: false, message: 'No encontrado' });
      reply.send({ ok: true, deleted: id });
    } catch (err: any) {
      // 1451 = cannot delete/update a parent row: a foreign key constraint fails
      if (err?.errno === 1451) {
        return reply.code(409).send({
          ok: false,
          message: 'No se puede eliminar: hay jugadores vinculados. Actualiza o elimina esas referencias primero.',
        });
      }
      reply.code(500).send({ ok: false, message: 'Error al eliminar sucursal', detail: err?.message });
    }
  });
}
