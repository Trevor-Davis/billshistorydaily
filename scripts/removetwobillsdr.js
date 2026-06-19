/**
 * remove-two-bills-drive.js
 *
 * One-time cleanup script: removes any article with source "Two Bills Drive"
 * from every daily JSON file in public/data/.
 *
 * Usage:
 *   node scripts/remove-two-bills-drive.js
 */

const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'public', 'data');
const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.json') && f !== 'index.json');

let totalRemoved = 0;
let filesChanged = 0;

for (const file of files) {
  const filePath = path.join(dataDir, file);
  const raw = fs.readFileSync(filePath, 'utf8');
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    console.log(`⚠ Skipping ${file} — invalid JSON`);
    continue;
  }

  if (!Array.isArray(data.articles)) continue;

  const before = data.articles.length;
  data.articles = data.articles.filter(a => {
    const source = (a.source || '').toLowerCase();
    return !source.includes('two bills drive');
  });
  const removed = before - data.articles.length;

  if (removed > 0) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    console.log(`✓ ${file}: removed ${removed} Two Bills Drive article(s)`);
    totalRemoved += removed;
    filesChanged++;
  }
}

console.log(`\nDone. ${filesChanged} file(s) changed, ${totalRemoved} article(s) removed total.`);