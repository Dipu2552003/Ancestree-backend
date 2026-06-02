import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import dotenv from 'dotenv'
import { testConnection } from './utils/db'
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

async function start() {
  try {
    await testConnection()
    console.log('✓ Connected to PostgreSQL')
    const dbUrl = process.env.DATABASE_URL
    if (!dbUrl) throw new Error('DATABASE_URL environment variable is not set')
    await runMigrations(dbUrl)
    app.listen(PORT, () => {
      console.log(`✓ Server running on http://localhost:${PORT}`)
      console.log(`  Routes: /api/auth  /api/persons  /api/relationships  /api/graph  /api/search  /api/invite  /api/merges  /api/notifications`)
    })
  } catch (err) {
    console.error('✗ Could not connect to PostgreSQL:', err)
    process.exit(1)
  }
}

start()
