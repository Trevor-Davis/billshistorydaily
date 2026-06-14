/**
 * fetch-daily.js
 *
 * Fetches the previous day's Buffalo Bills news via Anthropic API + web search,
 * fetches a relevant image from Unsplash,
 * saves everything to public/data/YYYY-MM-DD.json,
 * and updates public/data/index.json.
 *
 * Runs nightly at 2am ET via GitHub Actions.
 *
 * Manual usage:
 *   ANTHROPIC_API_KEY=sk-ant-... UNSPLASH_ACCESS_KEY=... node scripts/fetch-daily.js
 *   ANTHROPIC_API_KEY=sk-ant-... UNSPLASH_ACCESS_KEY=... node scripts/fetch-daily.js 2024-01-28
 */

const fs   = require('fs');
const path = require('path');

const API_KEY      = process.env.ANTHROPIC_API_KEY;
const UNSPLASH_KEY = process.env.UNSPLASH_ACCESS_KEY;

if (!API_KEY) {
  console.error('ERROR: ANTHROPIC_API_KEY environment variable is not set.');
  process.exit(1);
}
if (!UNSPLASH_KEY) {
  console.warn('WARNING: UNSPLASH_ACCESS_KEY not set. Images will be skipped.');
}

// ── Target date ───────────────────────────────────────────────────────────────
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

// ── Anthropic API call ────────────────────────────────────────────────────────
async function callAnthropic(prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const tb = data.content?.find(b => b.type === 'text');
  if (!tb) throw new Error('No text in response');
  return tb.text;
}

// ── Fetch Bills news ──────────────────────────────────────────────────────────
async function fetchDailyData(dateKey) {
  const readable = readableDate(dateKey);

  const prompt = `Search for all Buffalo Bills NFL news articles published on ${readable}.

You must respond with ONLY a JSON object — no other text whatsoever before or after it.

The JSON must have exactly this shape:
{
  "themes": ["short theme 1", "short theme 2", "short theme 3"],
  "writeup": "3-5 sentence editorial narrative of the day in engaging sports-journalism style",
  "imageQuery": "a 3-5 word Unsplash search query relevant to the top story (e.g. 'NFL quarterback touchdown pass' or 'football stadium crowd' or 'NFL draft pick')",
  "articles": [
    { "title": "Article headline", "source": "Publication name", "url": "https://..." }
  ]
}

Rules:
- themes: 2-4 noun phrases (4-6 words max each)
- writeup: flowing 3-5 sentence summary covering the main stories and their significance
- imageQuery: generic enough to get a good Unsplash photo (avoid player names, use descriptive football terms)
- articles: every distinct Bills news article from that date, 3-8 items, REAL URLs only
- If no Bills news: themes:["Quiet news day"], writeup:"No significant Bills news coverage found.", imageQuery:"Buffalo Bills football stadium", articles:[{"title":"No coverage found","source":"—","url":""}]
- Your response must be a valid JSON object starting with { and ending with }
- No text before or after the JSON. No markdown. No backticks. No preamble.`;

  const raw = await callAnthropic(prompt);
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in response: ' + raw.substring(0, 200));

  const parsed = JSON.parse(jsonMatch[0]);
  if (!parsed.themes || !parsed.writeup || !parsed.articles) {
    throw new Error('Response missing required fields: ' + JSON.stringify(parsed));
  }
  return parsed;
}

// ── Fetch Unsplash image ──────────────────────────────────────────────────────
async function fetchImage(query) {
  if (!UNSPLASH_KEY) return null;

  try {
    const q = encodeURIComponent(query);
    const res = await fetch(
      `https://api.unsplash.com/search/photos?query=${q}&per_page=1&orientation=landscape`,
      { headers: { Authorization: `Client-ID ${UNSPLASH_KEY}` } }
    );
    if (!res.ok) {
      console.warn('Unsplash error:', res.status);
      return null;
    }
    const data = await res.json();
    const photo = data.results?.[0];
    if (!photo) {
      console.warn('No Unsplash results for:', query);
      return null;
    }
    return {
      url: photo.urls.regular,
      thumb: photo.urls.thumb,
      small: photo.urls.small,
      alt: photo.alt_description || query,
      credit: photo.user.name,
      creditLink: photo.user.links.html + '?utm_source=bills_history_daily&utm_medium=referral'
    };
  } catch(e) {
    console.warn('Unsplash fetch failed:', e.message);
    return null;
  }
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
    console.log('Themes  :', data.themes.join(' | '));
    console.log('Articles:', data.articles.length);
    console.log('Image query:', data.imageQuery);

    // Fetch image from Unsplash
    if (data.imageQuery) {
      console.log('Fetching Unsplash image...');
      const image = await fetchImage(data.imageQuery);
      if (image) {
        data.image = image;
        console.log('✓ Image fetched:', image.url.substring(0, 60) + '...');
      } else {
        console.log('No image found, continuing without.');
      }
    }

    // Remove imageQuery from saved data (not needed in JSON)
    delete data.imageQuery;

    saveData(dateKey, data);
    console.log('\n✓ Done.\n');
  } catch (err) {
    console.error('\n✗ Failed:', err.message);
    process.exit(1);
  }
})();