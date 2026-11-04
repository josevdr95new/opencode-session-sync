// Declaraciones de módulos de build (vite ?inline, assets)
declare module '*.css?inline' {
  const css: string
  export default css
}
