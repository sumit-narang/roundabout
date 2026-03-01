import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { compression } from 'vite-plugin-compression2'

export default defineConfig({
  plugins: [
    react(),
    compression({ algorithm: 'brotliCompress', exclude: [/\.(png|webp|glb|wasm)$/] }),
    compression({ algorithm: 'gzip',           exclude: [/\.(png|webp|glb|wasm)$/] }),
  ],
})
