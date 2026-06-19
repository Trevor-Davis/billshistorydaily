/**
 * fill-missing-images.js
 *
 * Scans every daily JSON file in public/data/ and, for any file where
 * imageUrl is missing or empty, sets it to the default fallback image.
 *
 * Usage:
 *   node scripts/fill-missing-images.js
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_IMAGE = '/images/defaultimage.jpeg';

const dataDir = path.join(__dirname, '..', 'public', 'data');
const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.json') && f !== 'index.json');

let filled = 0;
let alreadyHadImage = 0;
const filledFiles = [];

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

  const hasImage = typeof data.imageUrl === 'string' && data.imageUrl.trim() !== '';

  if (!hasImage) {
    data.imageUrl = DEFAULT_IMAGE;
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    filled++;
    filledFiles.push(file);
    console.log(`✓ ${file}: set default image`);
  } else {
    alreadyHadImage++;
  }
}

console.log(`\nDone.`);
console.log(`${filled} file(s) updated with default image.`);
console.log(`${alreadyHadImage} file(s) already had an image.`);
if (filledFiles.length > 0) {
  console.log(`\nFiles updated:\n` + filledFiles.join('\n'));
}