import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 로컬 개발(serve)에서는 base를 '/'로 두어 localhost 루트에서 열리게 하고,
// 빌드/배포(build)에서는 GitHub Pages 경로 '/HTimeTable/'를 사용한다.
export default defineConfig(({ command }) => ({
  plugins: [react()],
  base: command === 'serve' ? '/' : '/HTimeTable/',
  // Gemini API는 CORS 지원으로 프록시 불필요
}));
