# Bills History Daily

**billshistorydaily.com** — The Daily Archive of the Buffalo Bills

## Quick start

```bash
npm install
npm start        # dev server at localhost:3000
```

## Deploy to GitHub Pages (first time)

```bash
npm run deploy
```

## How the daily automation works

Every night at **2am ET**, GitHub Actions:
1. Runs `scripts/fetch-daily.js` — calls Anthropic API with web search to fetch the previous day's Bills news
2. Saves the result as `public/data/YYYY-MM-DD.json`
3. Updates `public/data/index.json` (the list of all available dates)
4. Commits the new files to the repo
5. Rebuilds the React app and redeploys to GitHub Pages

## Setup checklist

### 1. Add your Anthropic API key to GitHub Secrets
- Repo → **Settings → Secrets and variables → Actions**
- New secret: `ANTHROPIC_API_KEY` = `sk-ant-...`

### 2. Set up the Vercel API proxy (keeps your key out of the browser)
- Import this repo into [vercel.com](https://vercel.com)
- Add environment variable: `ANTHROPIC_API_KEY` = `sk-ant-...`
- Vercel will deploy `api/claude.js` automatically

### 3. Custom domain
- In your domain registrar's DNS settings, add these A records pointing to GitHub Pages:
  - `185.199.108.153`
  - `185.199.109.153`
  - `185.199.110.153`
  - `185.199.111.153`
- Add CNAME: `www` → `YOUR-GITHUB-USERNAME.github.io`
- In GitHub repo → **Settings → Pages**, set custom domain to `billshistorydaily.com`

## Backfill a past date manually

```bash
ANTHROPIC_API_KEY=sk-ant-... node scripts/fetch-daily.js 2024-01-28
```

## Project structure

```
public/
  CNAME                     ← custom domain
  data/
    index.json              ← list of all available dates (newest first)
    2026-06-07.json         ← daily data files (auto-generated each morning)
    ...
api/
  claude.js                 ← Vercel serverless proxy (hides API key)
scripts/
  fetch-daily.js            ← daily news fetch script
src/
  App.jsx                   ← React app
  index.js
.github/
  workflows/
    daily.yml               ← runs every night at 2am ET
```
