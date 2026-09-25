const chapterPages = new Map([
  ['reading', 'reading.html'],
  ['model', 'model-and-tools.html'],
  ['tools', 'model-and-tools.html'],
  ['evidence', 'validation-and-execution.html'],
  ['runtime', 'validation-and-execution.html'],
  ['memory', 'memory-and-evaluation.html'],
  ['limits', 'memory-and-evaluation.html'],
  ['evaluation', 'memory-and-evaluation.html'],
]);
function redirectChapter() {
  const location = globalThis.location;
  const page = chapterPages.get(location.hash.slice(1));
  if (page) {
    location.replace(new URL(page + location.search + location.hash, location.href).href);
  }
}
redirectChapter();
globalThis.addEventListener('hashchange', redirectChapter);
