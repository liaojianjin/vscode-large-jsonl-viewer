import { parentPort, workerData } from 'node:worker_threads';
import { scanFile, type ScanControl } from '../index/scanner';
import type { OffsetStore } from '../index/store';
const port = parentPort!;
let store: OffsetStore | undefined, wake: (() => void) | undefined;
const control: ScanControl = { state: 'running', wait: () => new Promise(resolve => { wake = resolve; }) };
port.on('message', async message => {
  if (message.type === 'range') {
    try { if (!store) throw new Error('索引尚未就绪。'); port.postMessage({ type: 'range', id: message.id, range: await store.range(message.line) }); }
    catch (error) { port.postMessage({ type: 'range', id: message.id, error: String(error) }); }
  } else if (message.type === 'foreground') control.foreground = !!message.busy;
  else if (message.type === 'control') {
    control.state = message.state;
    if (control.state === 'disposed' && store?.complete) { port.close(); return; }
    wake?.(); wake = undefined;
  }
});
scanFile({ ...workerData, control, initialized: (s, source) => { store = s; port.postMessage({ type: 'initialized', source }); }, progress: progress => port.postMessage({ type: 'progress', progress }) }).then(() => {
  if (control.state === 'disposed') port.close();
}).catch(error => { port.postMessage({ type: 'failure', changed: error.name === 'FileChangedError', error: error.message }); });
