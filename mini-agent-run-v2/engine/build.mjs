import { build } from 'esbuild'
await build({
  entryPoints: ['engine/worker.mjs'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: 'runtime/verify.cjs',
  minify: true,
  legalComments: 'eof',
})
