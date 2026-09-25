const chapterPages = new Map([['reading', 'reading.html']]);
function redirectChapter() {
  const location = globalThis.location;
  const page = chapterPages.get(location.hash.slice(1));
  if (page) {
    location.replace(new URL(page + location.search + location.hash, location.href).href);
  }
}
redirectChapter();
globalThis.addEventListener('hashchange', redirectChapter);
