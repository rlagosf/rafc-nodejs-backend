// src/schemas/schemas.ts
import { FastifyInstance } from 'fastify';

/* ───────────────────────────────────────────────
   🔷 UTILIDADES BASE: Reutilizables en toda la API
─────────────────────────────────────────────── */

const Pagination = {
  type: 'object',
  properties: {
    limit: { type: 'integer' },
    offset: { type: 'integer' },
    count: { type: 'integer' },
  },
} as const;

const OkOnly = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
} as const;

/* ───────────────────────────────────────────────
   🔶 CATÁLOGOS (id + nombre)
─────────────────────────────────────────────── */

const CatalogoItem = {
  $id: 'CatalogoItem',
  type: 'object',
  properties: {
    id: { type: 'integer' },
    nombre: { type: 'string' },
  },
  required: ['id', 'nombre'],
} as const;

const CatalogoListResponse = {
  $id: 'CatalogoListResponse',
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    items: { type: 'array', items: { $ref: 'CatalogoItem#' } },
    count: { type: 'integer' },
  },
  required: ['ok', 'items'],
} as const;

/* ───────────────────────────────────────────────
   🔶 JUGADORES
─────────────────────────────────────────────── */

const Jugador = {
  $id: 'Jugador',
  type: 'object',
  properties: {
    id: { type: 'integer' },
    rut_jugador: { type: 'integer' },
    nombre_jugador: { type: 'string' },

    edad: { type: ['integer', 'null'] },
    email: { type: ['string', 'null'] },
    telefono: { type: ['string', 'null'] },
    direccion: { type: ['string', 'null'] },
    comuna_id: { type: ['integer', 'null'] },

    peso: { type: ['number', 'null'] },
    estatura: { type: ['number', 'null'] },

    talla_polera: { type: ['string', 'null'] },
    talla_short: { type: ['string', 'null'] },

    nombre_apoderado: { type: ['string', 'null'] },
    rut_apoderado: { type: ['integer', 'null'] },
    telefono_apoderado: { type: ['string', 'null'] },

    posicion_id: { type: ['integer', 'null'] },
    categoria_id: { type: ['integer', 'null'] },
    establec_educ_id: { type: ['integer', 'null'] },
    prevision_medica_id: { type: ['integer', 'null'] },
    estado_id: { type: ['integer', 'null'] },
    sucursal_id: { type: ['integer', 'null'] },

    estadistica_id: { type: ['integer', 'null'] },

    observaciones: { type: ['string', 'null'] },
    fecha_nacimiento: { type: ['string', 'null'], format: 'date' },
  },
  required: ['id', 'nombre_jugador', 'rut_jugador'],
} as const;

const JugadorListResponse = {
  $id: 'JugadorListResponse',
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    items: { type: 'array', items: { $ref: 'Jugador#' } },
    ...Pagination.properties,
  },
  required: ['ok', 'items'],
} as const;

/* ───────────────────────────────────────────────
   🔶 PAGOS JUGADOR
─────────────────────────────────────────────── */

const PagoJugador = {
  $id: 'PagoJugador',
  type: 'object',
  properties: {
    id: { type: 'integer' },
    jugador_rut: { type: 'integer' },
    tipo_pago_id: { type: 'integer' },
    situacion_pago_id: { type: 'integer' },

    monto: { type: 'number' },
    fecha_pago: { type: 'string', format: 'date' },

    medio_pago_id: { type: 'integer' },

    comprobante_url: { type: ['string', 'null'] },
    observaciones: { type: ['string', 'null'] },
  },
  required: [
    'id',
    'jugador_rut',
    'tipo_pago_id',
    'situacion_pago_id',
    'monto',
    'fecha_pago',
    'medio_pago_id',
  ],
} as const;

const PagoJugadorListResponse = {
  $id: 'PagoJugadorListResponse',
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    items: { type: 'array', items: { $ref: 'PagoJugador#' } },
  },
  required: ['ok', 'items'],
} as const;

/* ───────────────────────────────────────────────
   🔶 ESTADÍSTICAS (versión resumida)
─────────────────────────────────────────────── */

const Estadistica = {
  $id: 'Estadistica',
  type: 'object',
  additionalProperties: { type: ['integer', 'number', 'string', 'null'] },
  // NOTA: dejamos las keys dinámicas por compatibilidad
} as const;

const EstadisticaResponse = {
  $id: 'EstadisticaResponse',
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    items: { type: 'array', items: { $ref: 'Estadistica#' } },
  },
  required: ['ok'],
} as const;

/* ───────────────────────────────────────────────
   📌 REGISTRAR SCHEMAS
─────────────────────────────────────────────── */

export async function registerSchemas(app: FastifyInstance) {
  app.addSchema(CatalogoItem);
  app.addSchema(CatalogoListResponse);

  app.addSchema(Jugador);
  app.addSchema(JugadorListResponse);

  app.addSchema(PagoJugador);
  app.addSchema(PagoJugadorListResponse);

  app.addSchema(Estadistica);
  app.addSchema(EstadisticaResponse);
}
