/**
 * generate-sitemap.js
 *
 * Generates public/sitemap.xml from all published dates in public/data/index.json
 *
 * Usage:
 *   node scripts/generate-sitemap.js
 */

const fs   = require('fs');
const path = require('path');

const BASE_URL  = 'https://billshistorydaily.com';
const dataDir   = path.join(__dirname, '..', 'public', 'data');
const outputPath = path.join(__dirname, '..', 'public', 'sitemap.xml');

// Load index.json to get all published dates
const indexPath = path.join(dataDir, 'index.json');
if (!fs.existsSync(indexPath)) {
  console.error('index.json not found. Make sure you have published at least one day.');
  process.exit(1);
}

const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
const dates = index.dates || [];

console.log(`Generating sitemap for ${dates.length} published dates...`);

// Static pages
const staticPages = [
  { url: '/',          priority: '1.0', changefreq: 'daily'   },
  { url: '/#players',  priority: '0.5', changefreq: 'monthly' },
  { url: '/#draft',    priority: '0.5', changefreq: 'monthly' },
  { url: '/#schedule', priority: '0.6', changefreq: 'weekly'  },
  { url: '/#creators', priority: '0.4', changefreq: 'monthly' },
];

// Build XML
const today = new Date().toISOString().split('T')[0];

const urlEntries = [
  // Static pages
  ...staticPages.map(p => `
  <url>
    <loc>${BASE_URL}${p.url}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>
  </url>`),

  // Daily archive pages
  ...dates.map(dateKey => {
    // Try to get last modified from the data file
    const filePath = path.join(dataDir, `${dateKey}.json`);
    let lastmod = dateKey;
    if (fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      lastmod = stat.mtime.toISOString().split('T')[0];
    }
    return `
  <url>
    <loc>${BASE_URL}/#day/${dateKey}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>never</changefreq>
    <priority>0.7</priority>
  </url>`;
  })
].join('');

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urlEntries}
</urlset>`;

fs.writeFileSync(outputPath, xml);
console.log(`✓ Sitemap written to ${outputPath}`);
console.log(`  ${dates.length} day pages + ${staticPages.length} static pages = ${dates.length + staticPages.length} total URLs`);
console.log(`\nNext steps:`);
console.log(`  1. Run: git add public/sitemap.xml && git commit -m "Add sitemap" && git push`);
console.log(`  2. Deploy: $env:CI="false"; npm run deploy`);
console.log(`  3. Submit to Google: https://search.google.com/search-console`);
console.log(`     Go to Sitemaps > Add sitemap > enter: sitemap.xml`);