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
  // src/content/lib/mermaid.ts import()s a runtime URL on purpose; esbuild can't bundle it and must not.
  logOverride: { 'unsupported-dynamic-import': 'silent' },
};

// mermaid is not part of content.js (5 MB on every GitHub page): it is built as its own
// ES module that the content script import()s on demand. Its inputs never change while
// developing, so it is built once even in watch mode.
const mermaidBuild = (outfile) => ({
  entryPoints: ['src/mermaid/entry.ts'],
  outfile,
  format: 'esm',
  minify: true,
  sourcemap: false,
  once: true,
});

const builds = [
  { entryPoints: { background: 'src/background/index.ts' }, outdir },
  { entryPoints: { content: 'src/content/index.tsx' }, outdir },
  { entryPoints: { options: 'src/options/main.tsx' }, outdir },
  mermaidBuild(`${outdir}/mermaid.js`),
];

if (process.argv.includes('--harness')) {
  builds.push({ entryPoints: { harness: 'dev/harness.tsx' }, outdir: 'dev/out' }, mermaidBuild('dev/out/mermaid.js'));
}

for (const { once, ...b } of builds) {
  const opts = { ...common, ...b };
  if (watch && !once) {
    const ctx = await esbuild.context(opts);
    await ctx.watch();
  } else {
    await esbuild.build(opts);
  }
}
