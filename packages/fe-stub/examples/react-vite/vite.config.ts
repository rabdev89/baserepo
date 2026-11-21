import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `fe-stub run` sets FE_STUB_URL. When it's present, /api goes to the stub API.
// Plain `npm run dev` leaves your normal proxy / API URL untouched.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: process.env.FE_STUB_URL
      ? { '/api': { target: process.env.FE_STUB_URL, changeOrigin: true } }
      : undefined,
  },
});
