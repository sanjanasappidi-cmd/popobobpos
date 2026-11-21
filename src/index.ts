import Fastify from 'fastify';
import cors from '@fastify/cors';
import { initDatabase, isPostgresActive, lastPgError } from './db/database.js';
import { catalogRoutes } from './routes/catalogRoutes.js';
import { orderRoutes } from './routes/orderRoutes.js';
import { billingRoutes } from './routes/billingRoutes.js';
import { kitchenRoutes } from './routes/kitchenRoutes.js';
import { reportRoutes } from './routes/reportRoutes.js';
import { outletRoutes } from './routes/outletRoutes.js';

const fastify = Fastify({
  bodyLimit: 50 * 1024 * 1024, // 50 MB body limit to support base64 item photos
  logger: {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        ignore: 'pid,hostname',
      },
    },
  },
});

// Gracefully handle empty body even if client provides Content-Type: application/json
fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body: string, done) => {
  if (!body || body.trim() === '') {
    return done(null, {});
  }
  try {
    const json = JSON.parse(body);
    done(null, json);
  } catch (err: any) {
    done(err, undefined);
  }
});

async function startServer() {
  try {
    // 1. CORS Configuration
    await fastify.register(cors, {
      origin: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      credentials: true,
    });

    // 2. Initialize Database (PostgreSQL / SQLite WAL)
    fastify.log.info('Initializing production database engine...');
    await initDatabase();
    fastify.log.info(`Database engine: ${isPostgresActive ? '🐘 POSTGRESQL' : '🗄️ SQLITE (WAL Mode)'}`);

    // 3. Register Routes
    await fastify.register(catalogRoutes);
    await fastify.register(orderRoutes);
    await fastify.register(billingRoutes);
    await fastify.register(kitchenRoutes);
    await fastify.register(reportRoutes);
    await fastify.register(outletRoutes);

    // 4. Root Welcome & Health Check
    fastify.get('/', async () => ({
      name: "Pop O' Bob POS High-Performance Backend API",
      status: 'ONLINE',
      database: isPostgresActive ? 'POSTGRESQL' : 'SQLITE_WAL',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
    }));

    fastify.get('/health', async () => ({
      status: 'UP',
      database: isPostgresActive ? 'POSTGRESQL' : 'SQLITE_WAL',
      hasDatabaseUrl: Boolean(process.env.DATABASE_URL || (process.env as any)['DATABASE_URL.']),
      databaseType: process.env.DATABASE_TYPE || 'unset',
      pgError: lastPgError,
      memoryUsageMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    }));

    // 5. Start Listening
    const port = Number(process.env.PORT) || 8080;
    const host = process.env.HOST || '0.0.0.0';

    await fastify.listen({ port, host });
    fastify.log.info(`⚡ Pop O' Bob High-Performance POS Server running at http://${host}:${port}`);
    fastify.log.info(`🗄️ Active DB Engine: ${isPostgresActive ? 'PostgreSQL 18 (:5432)' : 'LibSQL SQLite WAL'}`);
    fastify.log.info(`📊 Memory footprint: ~${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB RAM (vs 600MB+ in Java)`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

startServer();
