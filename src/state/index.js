/**
 * State persistence abstraction.
 * - Local mode: reads/writes JSON files (existing behavior)
 * - S3 mode: reads/writes to S3 bucket (Lambda deployment)
 *
 * Usage:
 *   import { stateStore } from './state/index.js';
 *   const positions = await stateStore.load('positions');
 *   await stateStore.save('positions', positionsData);
 */
import { LocalStateStore } from './localStore.js';
import { S3StateStore } from './s3Store.js';

const useS3 = !!process.env.STATE_BUCKET;

export const stateStore = useS3
  ? new S3StateStore(process.env.STATE_BUCKET)
  : new LocalStateStore();

export { LocalStateStore, S3StateStore };
