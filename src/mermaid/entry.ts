// Built on its own into dist/mermaid.js (ESM) and imported on demand by
// src/content/lib/mermaid.ts, so the 5 MB library never loads on pages without diagrams.
export { default } from 'mermaid';
