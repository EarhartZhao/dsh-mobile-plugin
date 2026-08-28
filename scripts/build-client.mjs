/**
 * Build the browser half into the dsh client module format: a CJS bundle
 * wrapped in the lazy-factory handoff (`window.__ModuleLoader__.load`), with
 * platform rows (react, cordis, ui-slots...) external so the factory `require`
 * answers them from the loader's module table.
 *
 * Mirrors what the harness's tsdown clientBundle preset emits for in-repo
 * packages; reproduced here because the preset is not published.
 */
import { build } from 'esbuild'

const EXTERNALS = [
  'react',
  'react-dom',
  'react/jsx-runtime',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
]

await build({
  entryPoints: ['src/client/index.tsx'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
  external: EXTERNALS,
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'import.meta.env.MODE': JSON.stringify('production'),
    'import.meta.env': JSON.stringify({ MODE: 'production' }),
  },
  banner: {
    js: 'window.__ModuleLoader__.load({ id: "dsh-mobile-plugin", factory: (require) => { var module = { exports: {} }; var exports = module.exports;',
  },
  footer: {
    js: 'return module.exports; } });',
  },
})

console.log('built lib/client.js')
