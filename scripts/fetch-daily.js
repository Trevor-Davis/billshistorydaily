/**
 * fetch-daily.js — Bills History Daily
 * Two-step: (1) search for news, (2) format as JSON
 * Then tries to extract og:image from article pages.
 */

const fs   = require('fs');
const path = require('path');

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) { console.error('ERROR: ANTHROPIC_API_KEY not set.'); process.exit(1); }

function getTargetDate() {
  if (process.argv[2] && process.argv[2].trim()) return process.argv[2].trim();
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

function readableDate(key) {
  return new Date(key + 'T12:00:00').toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric'
  });
}

async function callAnthropic(messages, useSearch = false) {
  const body = {
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    messages
  };
  if (useSearch) {
    body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
  }
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });
  } catch(networkErr) {
    throw new Error(`Network error: ${networkErr.message}`);
  }
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const tb = data.content?.find(b => b.type === 'text');
  if (!tb) throw new Error('No text in response');
  return tb.text;
}

// ── Extract og:image from an article URL ─────────────────────────────────────
async function extractOgImage(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BillsHistoryBot/1.0)' },
      signal: AbortSignal.timeout(6000)
    });
    if (!res.ok) return null;
    const html = await res.text();

    // Try og:image
    const patterns = [
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
      /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i,
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match && match[1]) {
        const imgUrl = match[1].trim();
        if (imgUrl.match(/\.(svg|ico)$/i)) continue;
        if (imgUrl.length < 10) continue;
        console.log(`  ✓ Found og:image: ${imgUrl.substring(0, 70)}`);
        return imgUrl;
      }
    }
    return null;
  } catch(e) {
    console.log(`  Could not fetch ${url.substring(0, 50)}: ${e.message}`);
    return null;
  }
}

// ── Fetch Bills news ──────────────────────────────────────────────────────────
async function fetchDailyData(dateKey) {
  const readable = readableDate(dateKey);

  // Step 1: Search for news (free-form)
  console.log('Step 1: Searching for Bills news...');
  const searchResult = await callAnthropic([{
    role: 'user',
    content: `Search the web for Buffalo Bills NFL news and articles from ${readable}. 
Find as many relevant articles as possible. For each article note the title, source, and URL.
Also note the main topics/themes of the day's coverage.
Write a brief summary of what you found.`
  }], true);

  // Step 2: Format as JSON
  console.log('Step 2: Formatting as JSON...');
  const jsonResult = await callAnthropic([{
    role: 'user',
    content: `Here is a summary of Buffalo Bills news from ${readable}:

${searchResult}

Convert this into a JSON object with exactly this structure:
{
  "themes": ["theme 1", "theme 2", "theme 3"],
  "writeup": "3-5 sentence editorial summary",
  "articles": [
    {"title": "headline", "source": "publication", "url": "https://..."}
  ]
}

Rules:
- themes: 2-4 short noun phrases (4-6 words each)
- writeup: engaging 3-5 sentence sports journalism narrative
- articles: every article with its real URL
- If no Bills news: themes:["Quiet news day"], writeup:"No significant Bills news found.", articles:[{"title":"No coverage found","source":"—","url":""}]

Respond with ONLY the JSON object. No other text.`
  }], false);

  const jsonMatch = jsonResult.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in response: ' + jsonResult.substring(0, 200));

  const parsed = JSON.parse(jsonMatch[0]);
  if (!parsed.themes || !parsed.writeup || !parsed.articles) {
    throw new Error('Missing required fields: ' + JSON.stringify(parsed));
  }

  // Step 3: Try to extract og:image from each article
  console.log('Step 3: Looking for article image...');
  let imageUrl = '';
  for (const article of parsed.articles) {
    if (!article.url || article.url === '') continue;
    console.log(`  Trying: ${article.source}`);
    const img = await extractOgImage(article.url);
    if (img) {
      imageUrl = img;
      break;
    }
  }

  if (imageUrl) {
    parsed.imageUrl = imageUrl;
    console.log('✓ Image found');
  } else {
    parsed.imageUrl = '';
    console.log('No image found — app will use fallback.');
  }

  return parsed;
}

// ── Save data ─────────────────────────────────────────────────────────────────
function saveData(dateKey, data) {
  const dataDir = path.join(__dirname, '..', 'public', 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const dayPath = path.join(dataDir, `${dateKey}.json`);
  fs.writeFileSync(dayPath, JSON.stringify(data, null, 2));
  console.log(`✓ Saved ${dayPath}`);

  const indexPath = path.join(dataDir, 'index.json');
  let index = { dates: [] };
  if (fs.existsSync(indexPath)) {
    try { index = JSON.parse(fs.readFileSync(indexPath, 'utf8')); }
    catch(e) { console.warn('Could not parse index.json, rebuilding.'); }
  }
  if (!index.dates.includes(dateKey)) {
    index.dates.push(dateKey);
    index.dates.sort((a, b) => b.localeCompare(a));
  }
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
  console.log(`✓ Updated index.json (${index.dates.length} dates total)`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  const dateKey = getTargetDate();
  console.log(`\nFetching Bills news for: ${dateKey} (${readableDate(dateKey)})\n`);
  try {
    const data = await fetchDailyData(dateKey);
    saveData(dateKey, data);
    console.log('\n✓ Done.');
    console.log('Themes  :', data.themes.join(' | '));
    console.log('Articles:', data.articles.length);
    console.log('Image   :', data.imageUrl || '(none - will use fallback)');
  } catch (err) {
    console.error('\n✗ Failed:', err.message);
    process.exit(1);
  }
})();