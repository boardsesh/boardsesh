import { parentPort, workerData } from 'node:worker_threads';
import { loadModel, type LoadModelOptions } from './model';
import { detect } from './detect';

const port = parentPort;
if (!port) throw new Error('Inference must run in a worker thread');
const options = workerData as LoadModelOptions & { weightsSha256: string };
try {
  const model = await loadModel(options);
  if (model.manifest.version !== options.version || model.weightsSha256 !== options.weightsSha256)
    throw new Error('MODEL_IDENTITY_MISMATCH');
  port.postMessage({ type: 'ready' });
  port.on('message', async (photo: Uint8Array) => {
    try {
      const result = await detect(model.session, model.manifest, Buffer.from(photo), {
        outlines: true,
        tolerance: 0.5,
      });
      port.postMessage({ type: 'result', result });
    } catch {
      port.postMessage({ type: 'failed' });
    }
  });
} catch {
  port.postMessage({ type: 'failed' });
  port.close();
}
