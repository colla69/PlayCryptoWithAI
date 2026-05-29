import fs from 'fs';
import path from 'path';

const DATA_DIR = path.resolve(process.cwd(), 'data');

/**
 * Local filesystem state store (existing behavior).
 * Persists state as JSON files in data/ directory.
 */
export class LocalStateStore {
  #ensureDir() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  #filePath(key) {
    return path.join(DATA_DIR, `${key}.json`);
  }

  async load(key) {
    const filePath = this.#filePath(key);
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return null;
    }
  }

  async save(key, data) {
    this.#ensureDir();
    fs.writeFileSync(this.#filePath(key), JSON.stringify(data, null, 2));
  }

  async delete(key) {
    const filePath = this.#filePath(key);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }

  async list(prefix = '') {
    this.#ensureDir();
    const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
    if (!prefix) return files.map(f => f.replace('.json', ''));
    return files.filter(f => f.startsWith(prefix)).map(f => f.replace('.json', ''));
  }
}
