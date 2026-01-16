// src/db.ts
import mysql from 'mysql2/promise';
import { CONFIG } from './config';

let pool: mysql.Pool | null = null;
let initializing: Promise<mysql.Pool> | null = null;

// Mantiene compatibilidad para los imports antiguos: "db.query(...)"
export let db: mysql.Pool;

/**
 * Inicializa el pool de conexiones a MySQL (solo una vez).
 * Si varios módulos llaman a initDb() al mismo tiempo,
 * todos reutilizan la misma promesa y NO se crean múltiples pools.
 * database:realacad_development_database
 * username:realacad_development_database
 * pass:wAvhXuyWb4FwXV4pab7c
 */
export async function initDb(): Promise<mysql.Pool> {
  // Ya está creado → reutilizamos
  if (pool) return pool;

  // Ya se está inicializando → esperamos esa misma inicialización
  if (initializing) return initializing;

  // Arrancamos la inicialización una sola vez
  initializing = (async () => {
    try {
      const newPool = mysql.createPool({
        uri: CONFIG.DATABASE_URL,
        waitForConnections: true,

        // 🔧 BAJAMOS UN POCO LA CANTIDAD DE CONEXIONES
        // para no castigar tanto el hosting compartido
        connectionLimit: 4,

        // 🔧 Evitamos tener una cola infinita de peticiones
        // (cero = ilimitada). Un valor moderado es más sano.
        queueLimit: 50,
      });

      const conn = await newPool.getConnection();
      await conn.ping();

      try {
        const [[{ db: currentDb }]]: any = await conn.query(
          'SELECT DATABASE() AS db'
        );
        console.log(`🟢 Conectado correctamente a la base de datos: ${currentDb}`);
      } catch {
        console.log('⚠️ No se pudo identificar el nombre de la base de datos activa.');
      }

      conn.release();

      pool = newPool;
      db = newPool; // alias global para compatibilidad
      console.log('✅ Pool MySQL inicializado correctamente');

      return newPool;
    } catch (error) {
      console.error('❌ Error al conectar a la base de datos:', error);
      // Importante: limpiamos el estado para que futuros intentos puedan reintentar
      pool = null;
      initializing = null;
      throw error;
    } finally {
      // Quitamos la promesa de "en inicialización" una vez que termina
      // (éxito o error), así no queda colgada.
      initializing = null;
    }
  })();

  return initializing;
}

/**
 * Getter seguro para el pool una vez inicializado.
 * Si alguien intenta usarlo antes de llamar a initDb(), lanza error claro.
 */
export function getDb(): mysql.Pool {
  if (!pool) {
    throw new Error('La base de datos no está inicializada. Llama a await initDb() antes de usarla.');
  }
  return pool;
}
