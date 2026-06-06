import express, { type Request, type Response, type NextFunction } from 'express'
import cors from 'cors'
import helmet from 'helmet'
import dotenv from 'dotenv'
import pinoHttp from 'pino-http'
import { testConnection } from './utils/db'
import { logger } from './utils/logger'
import { runMigrations } from '../database/migrate'
import authRoutes          from './routes/auth.routes'
import personsRoutes       from './routes/persons.routes'
import relationshipsRoutes from './routes/relationships.routes'
import graphRoutes         from './routes/graph.routes'
import searchRoutes        from './routes/search.routes'
import inviteRoutes        from './routes/invite.routes'
import mergesRoutes        from './routes/merges.routes'
import notificationsRoutes from './routes/notifications.routes'

dotenv.config()

const app = express()
const PORT = process.env.PORT ?? 4000

app.use(helmet())
const allowedOrigins = (process.env.FRONTEND_URL ?? 'http://localhost:3000,http://localhost:5173')
  .split(',').map(o => o.trim())

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true)
    cb(new Error(`CORS: origin ${origin} not allowed`))
  },
  credentials: true,
}))
app.use(express.json())

app.use(pinoHttp({
  logger,
  customLogLevel: (_req, res, err) => {
    if (err || res.statusCode >= 500) return 'error'
    if (res.statusCode >= 400) return 'warn'
    return 'info'
  },
  redact: ['req.headers.authorization'],
  autoLogging: { ignore: (req) => req.url === '/health' },
}))

app.get('/health', async (_req, res) => {
  try {
    await testConnection()
    res.json({ status: 'ok', db: 'connected', timestamp: new Date().toISOString() })
  } catch (err) {
    res.status(503).json({ status: 'error', db: 'disconnected', error: String(err) })
  }
})

app.use('/api/auth',          authRoutes)
app.use('/api/persons',       personsRoutes)
app.use('/api/relationships', relationshipsRoutes)
app.use('/api/graph',         graphRoutes)
app.use('/api/search',        searchRoutes)
app.use('/api/invite',        inviteRoutes)
app.use('/api/merges',        mergesRoutes)
app.use('/api/notifications', notificationsRoutes)

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err }, 'unhandled error')
  res.status(500).json({ error: 'Internal server error' })
})

async function start() {
  try {
    await testConnection()
    logger.info('connected to PostgreSQL')
    const dbUrl = process.env.DATABASE_URL
    if (!dbUrl) throw new Error('DATABASE_URL environment variable is not set')
    await runMigrations(dbUrl)
    app.listen(PORT, () => {
      logger.info({ port: PORT }, 'server started')
    })
  } catch (err) {
    logger.error({ err }, 'failed to start server')
    process.exit(1)
  }
}

start()
