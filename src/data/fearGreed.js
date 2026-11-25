import fs from 'fs';

const CACHE = 'data/fearGreed.json';

const FETCH_TIMEOUT_MS = 15_000;
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * The daily history, from the cache when it already holds today's (UTC) value and
 * refetched otherwise — an age limit would keep serving a history without today,
 * which `getFearGreedValue` reads as neutral. A failed refresh returns the cache;
 * null only when there is none. Never throws: the cycle awaits it.
 */
export async function loadFearGreedHistory({ now = Date.now(), cachePath = CACHE, fetchImpl = fetch } = {}) {
  let cached = null;
  try {
    if (fs.existsSync(cachePath)) {
      const d = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      if (Array.isArray(d?.data) && d.data.length) cached = d.data;
    }
  } catch {
    // corrupt/unreadable cache — fall through to the network fetch below
  }
  if (cached?.some((e) => utcDay(e.ts) === utcDay(now))) return cached;
  try {
    const res = await fetchImpl('https://api.alternative.me/fng/?limit=1000&format=json', {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const json = await res.json();
    const data = json.data.map((d) => ({ ts: Number(d.timestamp) * 1000, value: Number(d.value) }))
      .filter((d) => Number.isFinite(d.ts) && Number.isFinite(d.value));
    if (!data.length) return cached;
    try {
      fs.writeFileSync(cachePath, JSON.stringify({ fetchedAt: now, data }));
    } catch {
      // the fetched history is still good for this cycle
    }
    return data;
  } catch {
    return cached;
  }
}

// Day → value per history array, built once: the scan compared date strings for every
// entry on every call — fine once a cycle live, 37 symbols × thousands of cycles in a
// replay. Same answer: the first entry of that UTC day, else neutral 50.
const dayIndex = new WeakMap();

export function getFearGreedValue(fgData, timestampMs) {
  if (!fgData) return 50;
  let byDay = dayIndex.get(fgData);
  if (!byDay) {
    byDay = new Map();
    for (const entry of fgData) {
      const day = new Date(entry.ts).toISOString().slice(0, 10);
      if (!byDay.has(day)) byDay.set(day, entry.value);
    }
    dayIndex.set(fgData, byDay);
  }
  return byDay.get(new Date(timestampMs).toISOString().slice(0, 10)) ?? 50;
}
