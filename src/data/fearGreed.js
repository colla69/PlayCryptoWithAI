import fs from 'fs';

const CACHE = 'data/fearGreed.json';

export async function loadFearGreedHistory() {
  if (fs.existsSync(CACHE)) {
    const d = JSON.parse(fs.readFileSync(CACHE, 'utf-8'));
    if (Date.now() - d.fetchedAt < 86400000) return d.data;
  }
  try {
    const res = await fetch('https://api.alternative.me/fng/?limit=1000&format=json');
    const json = await res.json();
    const data = json.data.map((d) => ({ ts: Number(d.timestamp) * 1000, value: Number(d.value) }));
    fs.writeFileSync(CACHE, JSON.stringify({ fetchedAt: Date.now(), data }));
    return data;
  } catch {
    return null;
  }
}

export function getFearGreedValue(fgData, timestampMs) {
  if (!fgData) return 50;
  const targetDay = new Date(timestampMs).toISOString().slice(0, 10);
  for (const entry of fgData) {
    if (new Date(entry.ts).toISOString().slice(0, 10) === targetDay) return entry.value;
  }
  return 50;
}
