// src/db.ts
import mysql from 'mysql2/promise';
import { CONFIG } from './config';

export let pool: mysql.Pool;
export let db!: mysql.Pool; // Mantiene compatibilidad para los imports "db.query(...)"

export async function initDb() {
  if (pool) return pool;

  try {
    pool = mysql.createPool({
      uri: CONFIG.DATABASE_URL,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
    });

    const conn = await pool.getConnection();
    await conn.ping();

    // 🔍 Verifica a qué base de datos se conectó realmente
    try {
      const [[{ db: currentDb }]]: any = await conn.query('SELECT DATABASE() AS db');
      console.log(`🟢 Conectado correctamente a la base de datos: ${currentDb}`);
    } catch {
      console.log('⚠️ No se pudo identificar el nombre de la base de datos activa.');
    }

    conn.release();

    // Alias global
    db = pool;
    console.log('✅ Pool MySQL inicializado correctamente');
    return pool;

  } catch (error) {
    console.error('❌ Error al conectar a la base de datos:', error);
    process.exit(1);
  }
}
