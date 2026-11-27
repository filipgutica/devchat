import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// The web UI builds into dist/ui, which the app serves at / (src/server/app.ts) and the package ships.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('../dist/ui', import.meta.url)),
    emptyOutDir: true,
    // The page's policy allows no data: URLs, so every asset is a file.
    assetsInlineLimit: 0,
  },
})
