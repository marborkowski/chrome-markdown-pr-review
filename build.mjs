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
  // The content script and the review import() runtime URLs on purpose; esbuild can't bundle them and must not.
  logOverride: { 'unsupported-dynamic-import': 'silent' },
};

// mermaid and KaTeX are not part of content.js (MBs on every GitHub page): each is built as its
// own ES module that the content script import()s on demand. Their inputs never change while
// developing, so they are built once even in watch mode.
const lazyBuild = (entry, outfile) => ({
  entryPoints: [entry],
  outfile,
  format: 'esm',
  minify: true,
  sourcemap: false,
  once: true,
});
const mermaidBuild = (outfile) => lazyBuild('src/mermaid/entry.ts', outfile);
const katexBuild = (outfile) => lazyBuild('src/math/entry.ts', outfile);

// The review UI is import()ed by the content script when a review is opened (ESM, rebuilt on change).
const reviewBuild = (outfile) => ({ entryPoints: ['src/review/entry.tsx'], outfile, format: 'esm' });

const builds = [
  { entryPoints: { background: 'src/background/index.ts' }, outdir },
  { entryPoints: { content: 'src/content/index.ts' }, outdir },
  reviewBuild(`${outdir}/review.js`),
  { entryPoints: { options: 'src/options/main.tsx' }, outdir },
  mermaidBuild(`${outdir}/mermaid.js`),
  katexBuild(`${outdir}/katex.js`),
];

if (process.argv.includes('--harness')) {
  builds.push({ entryPoints: { harness: 'dev/harness.tsx' }, outdir: 'dev/out' }, reviewBuild('dev/out/review.js'), mermaidBuild('dev/out/mermaid.js'), katexBuild('dev/out/katex.js'));
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
