import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const projectRoot = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  base: process.env.VITE_BASE || '/neon-guess-game-public/',
  root: projectRoot,
  plugins: [
    react({
      include: /\.[jt]sx?$/,
    }),
  ],
  esbuild: {
    jsx: 'automatic',
    include: /src\/.*\.[jt]sx?$/,
  },
  resolve: {
    alias: {
      '@': resolve(projectRoot, 'src'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    strictPort: true,
    allowedHosts: ['.manus.computer'],
  },
})

