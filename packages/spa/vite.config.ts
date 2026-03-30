import { defineConfig } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { nitro } from 'nitro/vite'

const config = defineConfig({
  plugins: [
    nitro(),
    tsconfigPaths({ projects: ['./tsconfig.json'] }),
    tanstackStart(),
    viteReact(),
  ],
})

export default config
