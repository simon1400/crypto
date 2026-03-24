import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { authMiddleware } from './middleware/auth'
import analyzeRouter from './routes/analyze'
import marketRouter from './routes/market'
import historyRouter from './routes/history'

const app = express()
const PORT = Number(process.env.PORT) || 3001

app.use(cors())
app.use(express.json())
app.use('/api', authMiddleware)

app.use('/api/analyze', analyzeRouter)
app.use('/api/market', marketRouter)
app.use('/api/history', historyRouter)

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})
