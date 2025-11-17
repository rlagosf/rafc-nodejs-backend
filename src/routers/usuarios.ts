import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z, type ZodIssue } from 'zod';
import * as argon2 from '@node-rs/argon2';
import { db } from '../db';

/**
 * Tabla: usuarios
 * Columnas:
 *  id, nombre_usuario, rut_usuario, email, password (hash argon2), rol_id, estado_id
 */

// ───────── Schemas ─────────
const IdParam = z.object({ id: z.string().regex(/^\d+$/) });
const RutParam = z.object({ rut_usuario: z.string().regex(/^\d{6,10}$/) });

const CreateSchema = z.object({
  nombre_usuario: z.string().trim().min(1),
  rut_usuario: z.union([z.coerce.number().int().positive(), z.string().regex(/^\d{6,10}$/)]),
  email: z.string().trim().email(),
  password: z.string().min(6),
  rol_id: z.coerce.number().int().positive(),
  estado_id: z.coerce.number().int().positive()
}).strict();

const UpdateSchema = z.object({
  nombre_usuario: z.string().trim().min(1).optional(),
  rut_usuario: z.union([z.coerce.number().int().positive(), z.string().regex(/^\d{6,10}$/)]).optional(),
  email: z.string().trim().email().optional(),
  password: z.string().min(6).optional(),
  rol_id: z.coerce.number().int().positive().optional(),
  estado_id: z.coerce.number().int().positive().optional()
}).strict();

// whitelist
const allowedKeys = new Set([
  'nombre_usuario',
  'rut_usuario',
  'email',
  'password',
  'rol_id',
  'estado_id'
]);

function pickAllowed(body: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const k in body) if (allowedKeys.has(k)) out[k] = (body as any)[k];
  return out;
}

function normalizeForDB(input: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...input };

  if (typeof out.nombre_usuario === 'string') {
    out.nombre_usuario = (out.nombre_usuario as string).trim();
  }
  if (typeof out.email === 'string') {
    out.email = (out.email as string).trim().toLowerCase();
  }
  if (out.rut_usuario != null) {
    const rutN = Number(out.rut_usuario);
    if (!Number.isNaN(rutN)) out.rut_usuario = rutN;
  }
  if (out.rol_id != null) out.rol_id = Number(out.rol_id);
  if (out.estado_id != null) out.estado_id = Number(out.estado_id);

  return out;
}

export default async function usuarios(app: FastifyInstance) {
  app.get('/health', async () => ({
    module: 'usuarios',
    status: 'ready',
    timestamp: new Date().toISOString()
  }));

  // LIST
  app.get('/', async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      const [rows] = await db.query(
        'SELECT id, nombre_usuario, rut_usuario, email, rol_id, estado_id FROM usuarios ORDER BY nombre_usuario ASC, id ASC'
      );
      reply.send({ ok: true, items: rows });
    } catch (err: any) {
      reply.code(500).send({ ok: false, message: 'Error al listar usuarios', detail: err?.message });
    }
  });

  // GET by id
  app.get('/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = IdParam.safeParse((req as any).params);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: 'ID inválido' });
    const id = Number(parsed.data.id);

    try {
      const [rows]: any = await db.query(
        'SELECT id, nombre_usuario, rut_usuario, email, rol_id, estado_id FROM usuarios WHERE id = ? LIMIT 1',
        [id]
      );
      if (!rows || rows.length === 0) return reply.code(404).send({ ok: false, message: 'No encontrado' });
      reply.send({ ok: true, item: rows[0] });
    } catch (err: any) {
      reply.code(500).send({ ok: false, message: 'Error al obtener usuario', detail: err?.message });
    }
  });

  // GET by rut
  app.get('/rut/:rut_usuario', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = RutParam.safeParse((req as any).params);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: 'RUT inválido' });
    const rut_usuario = parsed.data.rut_usuario;

    try {
      const [rows] = await db.query(
        'SELECT id, nombre_usuario, rut_usuario, email, rol_id, estado_id FROM usuarios WHERE rut_usuario = ? ORDER BY id DESC',
        [rut_usuario]
      );
      reply.send({ ok: true, items: rows });
    } catch (err: any) {
      reply.code(500).send({ ok: false, message: 'Error al buscar por RUT', detail: err?.message });
    }
  });

  // CREATE
  app.post('/', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = CreateSchema.safeParse((req as any).body);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((iss: ZodIssue) =>
        `${iss.path.join('.')}: ${iss.message}`
      ).join('; ');
      return reply.code(400).send({ ok: false, message: 'Payload inválido', detail });
    }

    const data = normalizeForDB(pickAllowed(parsed.data));
    try {
      data.password = await argon2.hash(String(data.password));
      const [result]: any = await db.query('INSERT INTO usuarios SET ?', [data]);

      reply.code(201).send({
        ok: true,
        id: result.insertId,
        nombre_usuario: data.nombre_usuario,
        rut_usuario: data.rut_usuario,
        email: data.email,
        rol_id: data.rol_id,
        estado_id: data.estado_id
      });
    } catch (err: any) {
      if (err?.errno === 1062) {
        return reply.code(409).send({ ok: false, message: 'Usuario duplicado (email o RUT ya existe)' });
      }
      reply.code(500).send({ ok: false, message: 'Error al crear usuario', detail: err?.message });
    }
  });

  // UPDATE (parcial)
  app.put('/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const pid = IdParam.safeParse((req as any).params);
    if (!pid.success) return reply.code(400).send({ ok: false, message: 'ID inválido' });
    const id = Number(pid.data.id);

    const parsed = UpdateSchema.safeParse((req as any).body);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((iss: ZodIssue) =>
        `${iss.path.join('.')}: ${iss.message}`
      ).join('; ');
      return reply.code(400).send({ ok: false, message: 'Payload inválido', detail });
    }

    const changes = normalizeForDB(pickAllowed(parsed.data));
    if (Object.keys(changes).length === 0) {
      return reply.code(400).send({ ok: false, message: 'No hay campos para actualizar' });
    }

    if (typeof changes.password === 'string') {
      changes.password = await argon2.hash(changes.password);
    }

    try {
      const [result]: any = await db.query('UPDATE usuarios SET ? WHERE id = ?', [changes, id]);
      if (result.affectedRows === 0) return reply.code(404).send({ ok: false, message: 'No encontrado' });

      const { password, ...safe } = changes;
      reply.send({ ok: true, updated: { id, ...safe } });
    } catch (err: any) {
      if (err?.errno === 1062) {
        return reply.code(409).send({ ok: false, message: 'Usuario duplicado (email o RUT ya existe)' });
      }
      reply.code(500).send({ ok: false, message: 'Error al actualizar usuario', detail: err?.message });
    }
  });

  // DELETE
  app.delete('/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = IdParam.safeParse((req as any).params);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: 'ID inválido' });
    const id = Number(parsed.data.id);

    try {
      const [result]: any = await db.query('DELETE FROM usuarios WHERE id = ?', [id]);
      if (result.affectedRows === 0) return reply.code(404).send({ ok: false, message: 'No encontrado' });
      reply.send({ ok: true, deleted: id });
    } catch (err: any) {
      reply.code(500).send({ ok: false, message: 'Error al eliminar usuario', detail: err?.message });
    }
  });
}
