// pdfjs-dist ships this worker build with no bundled type declarations.
// lib/pdf-import.ts imports it as a plain module (not a Worker) to force
// pdf.js into main-thread-only execution — see that file for why. Only the
// one export it actually reads is declared.
declare module 'pdfjs-dist/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: unknown;
}
