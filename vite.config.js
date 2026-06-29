import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 로컬 개발(serve)에서는 base를 '/'로 두어 localhost 루트에서 열리게 하고,
// 빌드/배포(build)에서는 상대경로 './'를 써서 GitHub Pages 경로·대소문자와 무관하게
// 에셋(assets)이 항상 정상 로드되도록 한다.
export default defineConfig(({ command }) => ({
  plugins: [react()],
  base: command === 'serve' ? '/' : './',
  // Gemini API는 CORS 지원으로 프록시 불필요
}));
