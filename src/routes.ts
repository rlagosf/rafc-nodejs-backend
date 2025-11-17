import { FastifyInstance } from 'fastify';

// Importa todos los routers (pueden estar vacíos por ahora)
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
  // Core
  app.register(auth, { prefix: '/auth' });
  app.register(usuarios, { prefix: '/usuarios' });
  app.register(roles, { prefix: '/roles' });

  // Dominio
  app.register(jugadores, { prefix: '/jugadores' });
  app.register(categorias, { prefix: '/categorias' });
  app.register(eventos, { prefix: '/eventos' });

  // Pagos
  app.register(medio_pago, { prefix: '/medio-pago' });
  app.register(pagos_jugador, { prefix: '/pagos-jugador' });
  app.register(tipo_pago, { prefix: '/tipo-pago' });
  app.register(situacion_pago, { prefix: '/situacion-pago' });

  // Catálogos/auxiliares
  app.register(posiciones, { prefix: '/posiciones' });
  app.register(estado, { prefix: '/estado' });
  app.register(prevision_medica, { prefix: '/prevision-medica' });
  app.register(establec_educ, { prefix: '/establecimientos-educ' });
  app.register(sucursales_real, { prefix: '/sucursales-real' });

  // Estadísticas y convocatorias
  app.register(estadisticas, { prefix: '/estadisticas' });
  app.register(convocatorias, { prefix: '/convocatorias' });
  app.register(convocatorias_historico, { prefix: '/convocatorias-historico' });
}
