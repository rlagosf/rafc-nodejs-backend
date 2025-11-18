// src/routes.ts
import { FastifyInstance } from 'fastify';

// Routers
import auth from './routers/auth';
import usuarios from './routers/usuarios';
import roles from './routers/roles';
import jugadores from './routers/jugadores';
import medio_pago from './routers/medio_pago';
import pagos_jugador from './routers/pagos_jugador';
import categorias from './routers/categorias';
import eventos from './routers/eventos';
import posiciones from './routers/posiciones';
import estado from './routers/estado';
import prevision_medica from './routers/prevision_medica';
import establec_educ from './routers/establec_educ';
import estadisticas from './routers/estadisticas';
import convocatorias from './routers/convocatorias';
import convocatorias_historico from './routers/convocatorias_historico';
import tipo_pago from './routers/tipo_pago';
import situacion_pago from './routers/situacion_pago';
import sucursales_real from './routers/sucursales_real';

export async function registerRoutes(app: FastifyInstance) {
  // Prefijo base para toda la API
  const API_BASE = '/api';

  // Core
  app.register(auth, { prefix: `${API_BASE}/auth` });
  app.register(usuarios, { prefix: `${API_BASE}/usuarios` });
  app.register(roles, { prefix: `${API_BASE}/roles` });

  // Dominio
  app.register(jugadores, { prefix: `${API_BASE}/jugadores` });
  app.register(categorias, { prefix: `${API_BASE}/categorias` });
  app.register(eventos, { prefix: `${API_BASE}/eventos` });

  // Pagos
  app.register(medio_pago, { prefix: `${API_BASE}/medio-pago` });
  app.register(pagos_jugador, { prefix: `${API_BASE}/pagos-jugador` });
  app.register(tipo_pago, { prefix: `${API_BASE}/tipo-pago` });
  app.register(situacion_pago, { prefix: `${API_BASE}/situacion-pago` });

  // Catálogos / auxiliares
  app.register(posiciones, { prefix: `${API_BASE}/posiciones` });
  app.register(estado, { prefix: `${API_BASE}/estado` });
  app.register(prevision_medica, { prefix: `${API_BASE}/prevision-medica` });
  app.register(establec_educ, { prefix: `${API_BASE}/establecimientos-educ` });
  app.register(sucursales_real, { prefix: `${API_BASE}/sucursales-real` });

  // Estadísticas y convocatorias
  app.register(estadisticas, { prefix: `${API_BASE}/estadisticas` });
  app.register(convocatorias, { prefix: `${API_BASE}/convocatorias` });
  app.register(convocatorias_historico, {
    prefix: `${API_BASE}/convocatorias-historico`,
  });
}
