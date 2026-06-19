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
    max_tokens: 4000,
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

// ── RSS feed fetching ────────────────────────────────────────────────────────
const RSS_FEEDS = [
  { name: 'Buffalo Rumblings', url: 'https://www.buffalorumblings.com/rss/index.xml', loose: true },
  { name: 'Buffalo Bills',     url: 'https://www.buffalobills.com/rss/news', loose: true },
  { name: 'Banged Up Bills',   url: 'https://bangedupbills.com/feed', loose: true },
  { name: 'WGR 550',           url: 'https://www.wgr550.com/feed/', loose: true, filter: ['bills', 'buffalo'] },
  { name: 'WKBW Bills',        url: 'https://www.wkbw.com/sports/buffalo-bills/rss', loose: true },
  { name: 'ESPN',              url: 'https://www.espn.com/espn/rss/nfl/news', loose: true, filter: ['bills', 'buffalo'] },
  { name: 'Pro Football Talk', url: 'https://profootballtalk.nbcsports.com/feed/', loose: true, filter: ['bills', 'buffalo'] },
];

function extractText(xml, tag) {
  // Try CDATA first
  let idx = xml.indexOf('<' + tag);
  if (idx === -1) return null;
  let start = xml.indexOf('>', idx) + 1;
  let end = xml.indexOf('</' + tag, start);
  if (end === -1) return null;
  let val = xml.slice(start, end).trim();
  // Strip CDATA wrapper if present
  if (val.startsWith('<![CDATA[')) {
    val = val.slice(9);
    if (val.endsWith(']]>')) val = val.slice(0, -3);
  }
  // Strip any remaining HTML tags
  return val.replace(/<[^>]+>/g, '').trim() || null;
}

function extractLink(item) {
  // Try href attribute (Atom)
  let m = item.match(/<link[^>]+href=["']([^"']+)["']/i);
  if (m) return m[1].trim();
  // Try plain link tag (RSS)
  m = item.match(/<link[^>]*>\s*(https?:\/\/[^\s<]+)/i);
  if (m) return m[1].trim();
  // Try guid as URL
  m = item.match(/<guid[^>]*>(https?:\/\/[^<]+)<\/guid>/i);
  if (m) return m[1].trim();
  return null;
}

async function fetchRssArticles(dateKey) {
  const targetDate = new Date(dateKey + 'T00:00:00Z');
  const nextDate   = new Date(dateKey + 'T23:59:59Z');
  const articles   = [];

  for (const feed of RSS_FEEDS) {
    try {
      console.log(`  Fetching RSS: ${feed.name}`);
      const res = await fetch(feed.url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; BillsHistoryBot/1.0)',
          'Accept': 'application/rss+xml, application/xml, text/xml, application/json, */*'
        },
        signal: AbortSignal.timeout(10000)
      });
      if (!res.ok) { console.log(`  ${feed.name}: HTTP ${res.status}`); continue; }

      // Handle JSON feeds (e.g. WordPress REST API)
      if (feed.json) {
        const posts = await res.json();
        console.log(`  ${feed.name}: ${posts.length} posts`);
        for (const post of posts) {
          const pubDate = new Date(post.date);
          if (isNaN(pubDate.getTime())) continue;
          if (pubDate < targetDate || pubDate > nextDate) continue;
          const title = post.title?.rendered?.replace(/<[^>]+>/g,'').trim() || post.title;
          const url   = post.link;
          if (title && url) {
            articles.push({ title, source: feed.name, url });
            console.log(`  ✓ ${title.substring(0, 70)}`);
          }
        }
        continue;
      }

      const xml = await res.text();
      console.log(`  ${feed.name}: got ${xml.length} chars`);

      const itemRe  = /<item[\s\S]*?<\/item>/gi;
      const entryRe = /<entry[\s\S]*?<\/entry>/gi;
      const items   = [...(xml.match(itemRe) || []), ...(xml.match(entryRe) || [])];
      console.log(`  ${feed.name}: ${items.length} items in feed`);
      for (const item of items) {
        const title = extractText(item, 'title');
        const url   = extractLink(item);
        if (!title || !url) continue;

        const rawDate = extractText(item, 'pubDate') ||
                        extractText(item, 'published') ||
                        extractText(item, 'updated') ||
                        extractText(item, 'dc:date');

        if (rawDate) {
          const pubDate = new Date(rawDate);
          if (!isNaN(pubDate.getTime())) {
            // loose: accept if within 2 days (for feeds with timezone issues)
            const slack = feed.loose ? 2 * 24 * 60 * 60 * 1000 : 0;
            if (pubDate < new Date(targetDate.getTime() - slack) ||
                pubDate > new Date(nextDate.getTime() + slack)) continue;
          }
        }

        // If feed has filter keywords, only include articles matching any of them
        if (feed.filter) {
          const keywords = Array.isArray(feed.filter) ? feed.filter : [feed.filter];
          const text = (title + ' ' + url).toLowerCase();
          if (!keywords.some(k => text.includes(k))) continue;
        }
        articles.push({ title, source: feed.name, url });
        console.log(`  ✓ ${title.substring(0, 70)}`);
      }
    } catch(e) {
      console.log(`  ${feed.name} RSS failed: ${e.message}`);
    }
  }

  console.log(`RSS total: ${articles.length} articles found`);
  return articles;
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

  // Step 1: Fetch RSS feeds first (fastest and most reliable)
  console.log('Step 1: Fetching RSS feeds...');
  const rssArticles = await fetchRssArticles(dateKey);
  const rssText = rssArticles.length > 0
    ? 'RSS FEED ARTICLES:\n' + rssArticles.map(a => `- ${a.title} (${a.source}) ${a.url}`).join('\n')
    : 'No RSS articles found for this date.';

  // Step 2: Search targeted Bills sites first, then general web
  console.log('Step 2: Searching Bills-specific sites...');

  const targetedSites = [
    'site:buffalobills.com',
    'site:buffalorumblings.com',
    'site:buffalonews.com',
    'site:twobillsdrive.com',
    'site:si.com/nfl/bills',
    'site:espn.com buffalo bills',
    'site:nfl.com buffalo bills',
    'site:profootballtalk.nbcsports.com buffalo bills',
  ];

  const targetedQuery = `Buffalo Bills ${readable} (${targetedSites.join(' OR ')})`;

  const targetedResult = await callAnthropic([{
    role: 'user',
    content: `Search for Buffalo Bills NFL news from ${readable} on these specific sites: buffalobills.com, buffalorumblings.com, buffalonews.com, twobillsdrive.com, si.com, espn.com, nfl.com, profootballtalk.nbcsports.com.

For each article you find, note the title, source site, and full URL.
Write a summary of what you found on these sites.`
  }], true);

  // Step 2b: General web search to catch anything missed
  console.log('Step 2b: Expanding to general web search...');
  const generalResult = await callAnthropic([{
    role: 'user',
    content: `Search the web broadly for any additional Buffalo Bills NFL news and articles from ${readable} that weren't already covered.
Focus on finding articles not from these sites (already searched): buffalobills.com, buffalorumblings.com, buffalonews.com, twobillsdrive.com, si.com, espn.com, nfl.com, profootballtalk.nbcsports.com.
For each article found, note the title, source, and URL.`
  }], true);

  const searchResult = `${rssText}\n\nTARGETED SITE RESULTS:\n${targetedResult}\n\nGENERAL WEB RESULTS:\n${generalResult}`;

  // Step 3: Format as JSON
  console.log('Step 3: Formatting as JSON...');

  // Limit combined content to avoid truncation
  const maxChars = 8000;
  const trimmedSearch = searchResult.length > maxChars
    ? searchResult.substring(0, maxChars) + '\n[...truncated]'
    : searchResult;

  const jsonResult = await callAnthropic([{
    role: 'user',
    content: `Here is a summary of Buffalo Bills news from ${readable}:

${trimmedSearch}

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

  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch(parseErr) {
    // Try to fix common JSON issues - truncated arrays, trailing commas
    let fixed = jsonMatch[0]
      .replace(/,\s*}/g, '}')          // trailing comma before }
      .replace(/,\s*]/g, ']')          // trailing comma before ]
      .replace(/[\x00-\x1F\x7F]/g, ' '); // control characters
    // If still broken, truncate at last clean article
    try {
      parsed = JSON.parse(fixed);
    } catch(e2) {
      // Find last complete article and close the JSON
      const lastGood = fixed.lastIndexOf('"}');
      if (lastGood > 0) {
        fixed = fixed.substring(0, lastGood + 2) + ']}';
        try { parsed = JSON.parse(fixed); }
        catch(e3) { throw new Error('Could not parse JSON: ' + parseErr.message); }
      } else {
        throw new Error('Could not parse JSON: ' + parseErr.message);
      }
    }
  }
  if (!parsed.themes || !parsed.writeup || !parsed.articles) {
    throw new Error('Missing required fields: ' + JSON.stringify(parsed));
  }

  // Merge in any RSS articles not already in the list
  const existingUrls = new Set(parsed.articles.map(a => a.url));
  for (const a of rssArticles) {
    if (!existingUrls.has(a.url)) {
      parsed.articles.push(a);
      existingUrls.add(a.url);
    }
  }

  // Step 4: Try to extract og:image from each article
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