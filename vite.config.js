import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { askHandler, authHandler } from './server/ask.js'
import { projectsHandler } from './server/projects.js'
import { startSupertonic, TTS_URL } from './server/tts.js'

// 백엔드는 dev 서버 미들웨어로만 둔다 — 프로세스 하나로 화면·claude 호출·TTS 를 같이 띄운다
const claudeApi = {
  name: 'claude-api',
  async configureServer(server) {
    server.middlewares.use('/api/ask', askHandler)
    server.middlewares.use('/api/auth', authHandler)
    server.middlewares.use('/api/projects', projectsHandler)
    const stopTts = await startSupertonic()
    server.httpServer?.on('close', stopTts)
  },
}

export default defineConfig({
  plugins: [react(), claudeApi],
  server: {
    host: 'localhost',
    port: 5173,
    proxy: {
      '^/api/tts$': { target: TTS_URL, rewrite: () => '/v1/tts' },
      '^/api/tts-health$': { target: TTS_URL, rewrite: () => '/v1/health' },
    },
  },
})
