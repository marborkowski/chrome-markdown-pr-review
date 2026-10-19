// Build script: bundles each extension entry point into a single classic script
// (content scripts and the MV3 service worker can't load ES module chunks).
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const dev = process.argv.includes('--dev') || watch;
const outdir = 'dist';

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });
cpSync('static', outdir, { recursive: true });

const common = {
  bundle: true,
  format: 'iife',
  target: ['chrome110'],
  minify: !dev,
  sourcemap: dev ? 'inline' : false,
  legalComments: 'none',
  loader: { '.css': 'text', '.md': 'text', '.patch': 'text' },
  define: { 'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production') },
  logLevel: 'info',
};

const builds = [
  { entryPoints: { background: 'src/background/index.ts' } },
  { entryPoints: { content: 'src/content/index.tsx' } },
  { entryPoints: { options: 'src/options/main.tsx' } },
];

if (process.argv.includes('--harness')) {
  builds.push({ entryPoints: { harness: 'dev/harness.tsx' }, outdir: 'dev/out' });
}

for (const b of builds) {
  const opts = { ...common, outdir, ...b };
  if (watch) {
    const ctx = await esbuild.context(opts);
    await ctx.watch();
  } else {
    await esbuild.build(opts);
  }
}
