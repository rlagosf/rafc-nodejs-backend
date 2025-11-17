// src/config.ts
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

// Detecta el entorno y carga el .env correspondiente
const isProd = process.env.NODE_ENV === 'production';
const envFile = isProd ? '.env.production' : '.env.development';
const envPath = path.resolve(process.cwd(), envFile);

// Carga el archivo si existe
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
  console.log(`🟢 Cargando variables desde ${envFile}`);
} else {
  console.warn(`⚠️ No se encontró ${envFile}, usando variables del entorno`);
}

// Helper para variables obligatorias
const must = (key: string, fallback?: string) => {
  const raw = process.env[key] ?? fallback;
  if (raw === undefined || String(raw).trim() === '') {
    throw new Error(`Falta variable de entorno: ${key}`);
  }
  return String(raw);
};

// Exporta la configuración global
export const CONFIG = {
  NODE_ENV: process.env.NODE_ENV ?? 'development',

  PORT: Number.isFinite(Number(process.env.PORT))
    ? Number(process.env.PORT)
    : 8000,

  JWT_SECRET: isProd
    ? must('JWT_SECRET')
    : must('JWT_SECRET', 'wR4%7nHq$2@z!8Fp^fC_39mLx$KjRqPzD'),

  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN ?? '12h',

  CORS_ORIGIN: isProd
    ? must('CORS_ORIGIN')
    : process.env.CORS_ORIGIN ?? 'http://localhost:5173',

  DATABASE_URL: must(
    'DATABASE_URL',
    isProd ? undefined : 'mysql://root:.-p3nt4k1lL@localhost:3306/rafc_reload'
  ),
};
