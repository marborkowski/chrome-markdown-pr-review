// Built on its own into dist/katex.js (ESM) and imported on demand by src/content/lib/math.ts,
// so KaTeX only loads for documents with math. Output is MathML (Chrome renders it natively),
// so no KaTeX fonts or stylesheet are needed inside the shadow DOM.
export { renderToString } from 'katex';
