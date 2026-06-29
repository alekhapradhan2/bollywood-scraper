# Bollywood Scraper for Ollypedia

Automated pipeline that collects, validates, enriches, and stores data for **all Hindi/Bollywood theatrical movies from 2015 to the present** into your existing Ollypedia MongoDB database — without touching any existing APIs, schemas, or application code.

---

## Architecture

```
TMDB (primary) ──┐
OMDb/IMDb ────────┤
Wikipedia ────────┼──► Merger (confidence scoring) ──► Validator ──► MongoDB
BollywoodHungama ─┤
Sacnilk ──────────┤
YouTube ──────────┘
```

### Pipeline per movie
1. **TMDB** — full details, credits (cast + 12 crew roles), images, videos, keywords
2. **OMDb** — IMDb rating, votes, awards, content rating, Rotten Tomatoes
3. **Wikipedia** — plot, infobox (director, budget, box office, distributor)
4. **BollywoodHungama** — cast list, box office summary, synopsis
5. **Sacnilk** — day-wise net/gross collections
6. **YouTube** — official trailer (fallback when TMDB has none)
7. **Merge** — confidence-weighted field selection across all sources
8. **Validate** — enforce minimum required fields before saving
9. **Save** — upsert into MongoDB with full duplicate protection

---

## Setup

### 1. Copy this directory alongside your server.js

```
your-project/
├── server.js          ← untouched
├── package.json       ← untouched
└── bollywood-scraper/ ← new directory
    ├── index.js
    ├── .env
    └── src/
```

### 2. Install dependencies

```bash
cd bollywood-scraper
npm install
```

### 3. Configure .env

```bash
cp .env.example .env
```

Edit `.env`:

```env
# Same MongoDB URI as your server.js
MONGO_URI=mongodb+srv://user:pass@cluster.mongodb.net/ollypedia

# Free — https://www.themoviedb.org/settings/api
TMDB_API_KEY=your_key

# Free tier: 1000/day — https://www.omdbapi.com/apikey.aspx
OMDB_API_KEY=30ad8e86

# Optional — YouTube Data API v3 from Google Cloud Console
YOUTUBE_API_KEY=your_key
```

**TMDB_API_KEY is the only hard requirement.** OMDb and YouTube improve quality but are optional.

---

## Running

### Full run — all movies 2015 to present

```bash
node index.js
```

Expected: ~3,000–5,000 movies. Takes 4–8 hours depending on API rate limits. Fully restartable — just run again after interruption.

### Single year

```bash
node index.js --year=2023
```

### Year range

```bash
node index.js --from=2020 --to=2022
```

### Incremental update (new releases only)

```bash
node index.js --incremental
```

Runs only for the current and previous year. Ideal for weekly/monthly updates.

### Retry failed movies

```bash
node index.js --retry-failed
```

### Start fresh (wipe checkpoint)

```bash
node index.js --reset
```

### Validate DB (check for missing fields)

```bash
node index.js --validate
```

### Nightly cron daemon (2 AM IST)

```bash
node index.js --cron
# Runs as background process; use PM2 for production
pm2 start index.js --name bollywood-cron -- --cron
```

---

## Duplicate Protection

Movies are matched in order:
1. **IMDb ID** (most reliable — `tt1234567`)
2. **Slug** (`uri-2023`)
3. **Title + year** (case-insensitive)

When a match is found:
- Only **missing or empty fields** are updated
- Manually admin-edited fields (synopsis, director, poster, cast) are **never overwritten** if already set
- Protected fields: `slug`, `reviews`, `news`, `streamingOn`, `ottReleaseDate`, `detailBlogId`, `songBlogIds`, blog IDs

---

## Cast Deduplication

Each actor/crew member is matched against the existing `Cast` collection by **name (case-insensitive)**. If found, the existing `_id` is reused (no duplicates). If not found, a new Cast document is created with TMDB person bio, photo, DOB, and gender.

All created Cast documents are linked back via `Cast.movies[]`.

---

## Data Sources and Confidence

| Source | Weight | Used For |
|--------|--------|----------|
| TMDB | 1.00 | Title, genres, cast/crew, poster, trailer |
| IMDb/OMDb | 0.95 | IMDb rating, awards, content rating |
| OMDb | 0.90 | Plot, runtime, box office (USD) |
| Wikipedia | 0.85 | Plot, budget, box office (INR), infobox |
| Sacnilk | 0.75 | Day-wise box office collections |
| BollywoodHungama | 0.70 | Cast, box office summary |
| YouTube | 0.60 | Trailer fallback |

For each field, the highest-confidence non-empty value wins.

---

## Minimum Validation

Before any movie is saved, these fields must be present:
- `title`
- `releaseDate` or `releaseYear`
- `posterUrl`
- `synopsis` (≥ 20 characters)

Movies that fail validation are logged and skipped (not saved).

---

## Logs

```
bollywood-scraper/logs/
├── scraper.log     ← all events (rotates at 10 MB)
└── errors.log      ← errors only
```

## Checkpoints

```
bollywood-scraper/checkpoints/progress.json
```

Contains processed IDs, failed IDs, per-year progress, and running stats. Automatically saved after every batch of 20 movies.

---

## Rate Limiting

- **TMDB**: 4 concurrent requests, 800ms polite delay between calls to same domain
- **OMDb**: sequential with delay  
- **Scraping** (BH, Sacnilk, Wikipedia): 2 concurrent, 800ms delay
- **Retries**: 3 attempts with exponential backoff (2s, 4s, 6s)

TMDB free tier allows 40 requests/10 seconds — the 4-concurrency + delays stay well within this.

---

## What Gets Scraped

### Per movie
- Title (Hindi + English), original title, tagline
- Release date, year, runtime, language, certification
- Synopsis, plot, about
- Genres (normalized)
- Director, producer, writer, music director, cinematographer, editor
- Production companies
- IMDb ID, IMDb rating, TMDB rating
- Poster, banner, thumbnail URLs
- Budget (INR), box office — opening, week 1, total
- Day-wise box office (up to 100 days where available)
- Status, verdict (Blockbuster/Hit/Average/Flop etc.)
- Official website, keywords, awards
- Trailer (YouTube ID + URL)

### Per cast/crew member
- Name, photo, type/role
- Bio, DOB, gender, location (from TMDB person endpoint)
- Linked to all their movies via `Cast.movies[]`
