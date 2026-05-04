import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    https: {
      key: fs.readFileSync(path.resolve(__dirname, '../server/key.pem')),
      cert: fs.readFileSync(path.resolve(__dirname, '../server/cert.pem')),
    },
    proxy: {
      '/socket.io': {
        target: 'https://localhost:3001',
        ws: true,
        secure: false
      },
      '/v1': {
        target: 'https://localhost:3001',
        secure: false
      }
    }
  }
})
