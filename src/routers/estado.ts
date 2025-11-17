import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db } from '../db';

/**
 * Tabla: estado
 * Campos: id (PK), nombre (VARCHAR)
 * Modo: solo lectura
 */

const IdParam = z.object({ id: z.string().regex(/^\d+$/) });

export default async function estado(app: FastifyInstance) {
  // Health del módulo
  app.get('/health', async () => ({
    module: 'estado',
    status: 'ready',
    timestamp: new Date().toISOString()
  }));

  // GET /estado -> lista todos (id, nombre)
  app.get('/', async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      const [rows] = await db.query('SELECT id, nombre FROM estado ORDER BY id ASC');
      reply.send({ ok: true, items: rows });
    } catch (err: any) {
      reply.code(500).send({ ok: false, message: 'Error al listar estado', error: err?.message });
    }
  });

  // GET /estado/:id -> obtiene uno por id
  app.get('/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = IdParam.safeParse((req as any).params);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: 'ID inválido' });

    const id = Number(parsed.data.id);
    try {
      const [rows]: any = await db.query('SELECT id, nombre FROM estado WHERE id = ? LIMIT 1', [id]);
      if (!rows || rows.length === 0) return reply.code(404).send({ ok: false, message: 'No encontrado' });
      reply.send({ ok: true, item: rows[0] });
    } catch (err: any) {
      reply.code(500).send({ ok: false, message: 'Error al obtener estado', error: err?.message });
    }
  });
}
