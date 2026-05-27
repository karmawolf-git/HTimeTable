import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/HTimeTable/',
  // Gemini API는 CORS 지원으로 프록시 불필요
});
