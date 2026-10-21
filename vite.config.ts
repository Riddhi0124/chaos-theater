import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub Pages serves the site from /chaos-theater/
export default defineConfig(({ command }) => ({
  plugins: [react()],
  base: command === 'build' ? '/chaos-theater/' : '/',
}))
