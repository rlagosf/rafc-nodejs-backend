// src/middlewares/authz.ts
import type { FastifyReply, FastifyRequest } from "fastify";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET as string;

type AnyObj = Record<string, any>;

function extractUser(decoded: AnyObj): AnyObj {
  // soporta tokens donde vienen anidados
  return decoded?.user ?? decoded?.payload ?? decoded ?? {};
}

function extractRole(user: AnyObj): number | null {
  const raw =
    user?.rol_id ??
    user?.role_id ??
    user?.roleId ??
    user?.rolId ??
    user?.rol ??
    user?.role ??
    null;

  if (raw === null || raw === undefined) return null;

  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const auth = req.headers.authorization || "";
  const [bearer, token] = auth.split(" ");

  if (bearer !== "Bearer" || !token) {
    return reply.code(401).send({ ok: false, message: "UNAUTHORIZED" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as AnyObj;
    const user = extractUser(decoded);

    // dejamos esto estable y único en toda la API:
    (req as any).user = user;
    (req as any).role_id = extractRole(user); // útil para debug

  } catch (e) {
    return reply.code(401).send({ ok: false, message: "INVALID_TOKEN" });
  }
}

export function requireRoles(allowed: number[]) {
  const set = new Set(allowed.map(Number));

  return async function (req: FastifyRequest, reply: FastifyReply) {
    const user = (req as any).user ?? null;
    const role = extractRole(user);

    if (role == null || !set.has(role)) {
      req.log.warn(
        { role, userKeys: user ? Object.keys(user) : null },
        "[authz] forbidden by role"
      );
      return reply.code(403).send({ ok: false, message: "FORBIDDEN" });
    }
  };
}
