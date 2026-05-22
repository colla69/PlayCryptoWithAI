import { EventEmitter } from 'events';

export const signalBus = new EventEmitter();
// 34 portfolio symbols each add a listener — raise limit to avoid warning
signalBus.setMaxListeners(50);
export default signalBus;
