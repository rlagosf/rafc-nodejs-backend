import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db } from '../db';

/** Tabla: situacion_pago  |  Campos: id, nombre  (solo lectura) */
const IdParam = z.object({ id: z.string().regex(/^\d+$/) });

export default async function situacion_pago(app: FastifyInstance) {
  app.get('/health', async () => ({
    module: 'situacion_pago',
    status: 'ready',
    timestamp: new Date().toISOString()
  }));

  app.get('/', async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      const [rows] = await db.query('SELECT id, nombre FROM situacion_pago ORDER BY id ASC');
      reply.send({ ok: true, items: rows });
    } catch (err: any) {
      reply.code(500).send({ ok: false, message: 'Error al listar situacion_pago', error: err?.message });
    }
  });

  app.get('/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = IdParam.safeParse((req as any).params);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: 'ID inválido' });

    const id = Number(parsed.data.id);
    try {
      const [rows]: any = await db.query('SELECT id, nombre FROM situacion_pago WHERE id = ? LIMIT 1', [id]);
      if (!rows || rows.length === 0) return reply.code(404).send({ ok: false, message: 'No encontrado' });
      reply.send({ ok: true, item: rows[0] });
    } catch (err: any) {
      reply.code(500).send({ ok: false, message: 'Error al obtener situacion_pago', error: err?.message });
    }
  });
}
