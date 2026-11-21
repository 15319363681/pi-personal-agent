import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { extname } from 'node:path';

const failure = (code) => Object.assign(new Error(code), { code });
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const IMAGE_MAX_PIXELS = 16_000_000;
const FORMATS = new Map([['jpg', 'jpeg'], ['jpeg', 'jpeg'], ['png', 'png'], ['webp', 'webp'], ['gif', 'gif']]);
const PARSER_CODES = new Set(['image_pixel_limit', 'image_decode_failed']);

function detectFormat(data) {
  if (data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'jpeg';
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii'))) return 'gif';
  if (data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  throw failure('image_decode_failed');
}

export class ImageReader {
  constructor({ timeoutMs = 10_000 } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw failure('image_request_invalid');
    this.timeoutMs = timeoutMs;
  }

  async read(workspace, path) {
    if (typeof path !== 'string' || !path.trim()) throw failure('image_request_invalid');
    const expectedFormat = FORMATS.get(extname(path).slice(1).toLowerCase());
    if (!expectedFormat) throw failure('image_format_unsupported');
    const file = await workspace.read(path, { maxBytes: IMAGE_MAX_BYTES });
    if (file.status !== 'ok') throw failure('image_missing');
    const format = detectFormat(file.data);
    if (format !== expectedFormat) throw failure('image_format_mismatch');
    const worker = new Worker(new URL('./image-parser.mjs', import.meta.url), {
      workerData: { data: file.data, maxPixels: IMAGE_MAX_PIXELS },
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
      env: {}, stdout: true, stderr: true
    });
    worker.stdout.resume();
    worker.stderr.resume();
    let timer;
    try {
      const parsed = await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(failure('image_timeout')), this.timeoutMs);
        worker.once('message', (message) => message.ok ? resolve(message.result) : reject(failure(PARSER_CODES.has(message.code) ? message.code : 'image_decode_failed')));
        worker.once('error', () => reject(failure('image_decode_failed')));
        worker.once('exit', () => reject(failure('image_decode_failed')));
      });
      return {
        status: 'ok',
        image: { type: 'image', data: Buffer.from(parsed.data).toString('base64'), mimeType: 'image/jpeg' },
        source: {
          path, format, sha256: createHash('sha256').update(file.data).digest('hex'), size: file.data.length,
          width: parsed.width, height: parsed.height,
          submittedWidth: parsed.submittedWidth, submittedHeight: parsed.submittedHeight,
          frames: parsed.frames, firstFrameOnly: parsed.frames > 1
        }
      };
    } finally {
      clearTimeout(timer);
      await worker.terminate();
    }
  }
}
