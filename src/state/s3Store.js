import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

/**
 * S3-backed state store for Lambda deployment.
 * All state is stored as JSON objects in the configured bucket.
 */
export class S3StateStore {
  #client;
  #bucket;

  constructor(bucket) {
    this.#bucket = bucket;
    this.#client = new S3Client({});
  }

  #key(name) {
    return `state/${name}.json`;
  }

  async load(key) {
    try {
      const resp = await this.#client.send(new GetObjectCommand({
        Bucket: this.#bucket,
        Key: this.#key(key),
      }));
      const body = await resp.Body.transformToString();
      return JSON.parse(body);
    } catch (err) {
      if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }

  async save(key, data) {
    await this.#client.send(new PutObjectCommand({
      Bucket: this.#bucket,
      Key: this.#key(key),
      Body: JSON.stringify(data, null, 2),
      ContentType: 'application/json',
    }));
  }

  async delete(key) {
    await this.#client.send(new DeleteObjectCommand({
      Bucket: this.#bucket,
      Key: this.#key(key),
    }));
  }

  async list(prefix = '') {
    const resp = await this.#client.send(new ListObjectsV2Command({
      Bucket: this.#bucket,
      Prefix: `state/${prefix}`,
    }));
    return (resp.Contents ?? [])
      .map(obj => obj.Key.replace('state/', '').replace('.json', ''))
      .filter(Boolean);
  }

  /**
   * Append a line to a log-style object (for trade history, logs).
   * Reads existing array, pushes new entry, writes back.
   */
  async append(key, entry) {
    const existing = await this.load(key) ?? [];
    existing.push(entry);
    await this.save(key, existing);
    return existing;
  }
}
