import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import dotenv from 'dotenv'
import { testConnection } from './utils/db'
import authRoutes          from './routes/auth.routes'
import personsRoutes       from './routes/persons.routes'
import relationshipsRoutes from './routes/relationships.routes'
import graphRoutes         from './routes/graph.routes'
import searchRoutes        from './routes/search.routes'

dotenv.config()

const app = express()
const PORT = process.env.PORT ?? 4000

app.use(helmet())
app.use(cors())
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

async function start() {
  try {
    await testConnection()
    console.log('✓ Connected to PostgreSQL')
    app.listen(PORT, () => {
      console.log(`✓ Server running on http://localhost:${PORT}`)
      console.log(`  Routes: /api/auth  /api/persons  /api/relationships  /api/graph  /api/search`)
    })
  } catch (err) {
    console.error('✗ Could not connect to PostgreSQL:', err)
    process.exit(1)
  }
}

start()
