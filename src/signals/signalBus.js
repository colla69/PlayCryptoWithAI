import { EventEmitter } from 'events';

export const signalBus = new EventEmitter();
export default signalBus;
