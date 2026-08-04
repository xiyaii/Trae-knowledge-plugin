import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'src/index.tsx'),
      output: {
        format: 'iife',
        name: 'KBApp',
        entryFileNames: 'assets/index.js',
        assetFileNames: 'assets/index.[ext]',
        inlineDynamicImports: true,
      },
    },
    cssCodeSplit: false,
    minify: false,
  },
});
