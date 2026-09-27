import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import config, { validateEnv } from './config/env.js';
import researchRoutes from './routes/researchRoutes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Body Parser Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend files
app.use(express.static(path.join(__dirname, '../public')));

// Health check endpoint
app.get('/api/health', (req, res) => {
  const envValidation = validateEnv();
  res.json({
    status: 'ok',
    service: 'Autonomous Research Agent API',
    environment: config.nodeEnv,
    groqConfigured: envValidation.valid,
    provider: 'Groq AI',
    model: config.groqModel,
    timestamp: new Date().toISOString(),
  });
});

// Mount Research Agent Routes
app.use('/api', researchRoutes);

// Global Error Handler Middleware
app.use((err, req, res, next) => {
  console.error('[ServerError] Unhandled Request Error:', err);
  res.status(err.status || 500).json({
    success: false,
    error: err.message || 'Internal Server Error',
  });
});

const PORT = config.port;

// Only start listening if executed directly (not when imported by test suites)
const isTestEnv = process.env.NODE_ENV === 'test' || process.argv.some((arg) => arg.includes('test'));

if (!isTestEnv) {
  app.listen(PORT, () => {
    console.log(`[Autonomous Agent] Server running on http://localhost:${PORT}`);
  });
}

export default app;
