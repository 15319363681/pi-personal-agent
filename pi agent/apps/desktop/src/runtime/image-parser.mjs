import { parentPort, workerData } from 'node:worker_threads';
import sharp from 'sharp';

sharp.cache(false);
sharp.concurrency(1);

try {
  const bytes = Buffer.from(workerData.data);
  const metadata = await sharp(bytes, { pages: 1, limitInputPixels: false }).metadata();
  const width = metadata.width;
  const height = metadata.pageHeight ?? metadata.height;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > workerData.maxPixels) {
    throw Object.assign(new Error('image_pixel_limit'), { code: 'image_pixel_limit' });
  }
  const { data, info } = await sharp(bytes, { pages: 1, limitInputPixels: workerData.maxPixels, failOn: 'warning' })
    .autoOrient()
    .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: 'white' })
    .jpeg({ quality: 85 })
    .timeout({ seconds: 8 })
    .toBuffer({ resolveWithObject: true });
  parentPort.postMessage({ ok: true, result: { data, width, height, submittedWidth: info.width, submittedHeight: info.height, frames: metadata.pages ?? 1 } });
} catch (error) {
  parentPort.postMessage({ ok: false, code: error.code === 'image_pixel_limit' ? error.code : 'image_decode_failed' });
}
