import { defineConfig } from 'vite'
import { gui } from '@opencode/plugin/gui/vite'

// Build del paquete gui-experimental: un único dist/gui-experimental.cjs.
// El preset compila Solid JSX, inlinea imports dinámicos y deja externos los módulos
// compartidos (solid-js, @opencode/*, effect, electron, node built-ins).
export default defineConfig({ plugins: [gui()] })
