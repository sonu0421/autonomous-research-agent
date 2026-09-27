import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env file from project root
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

/**
 * Validates and exports environment configuration.
 */
export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  groqApiKey: process.env.GROQ_API_KEY || '',
  groqModel: process.env.GROQ_MODEL || 'openai/gpt-oss-20b',
  groqBaseUrl: 'https://api.groq.com/openai/v1',
  exportsDir: path.resolve(__dirname, '../../exports'),
};

/**
 * Validates required environment variables for Groq API execution.
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateEnv() {
  const errors = [];

  const key = config.groqApiKey;
  if (!key || key === 'your_groq_api_key_here') {
    errors.push('GROQ_API_KEY is missing or set to placeholder in .env file.');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export default config;
