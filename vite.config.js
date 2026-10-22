import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 화면만 빌드한다. CLI 호출·TTS·파일 접근은 Tauri(Rust) 쪽이 맡는다
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { host: 'localhost', port: 5173, strictPort: true },
})
