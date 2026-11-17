export function encode(message) { return JSON.stringify(message); }
export function decodeLines(buffer) {
  return buffer.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

export class RpcClient {
  constructor(processLike) {
    this.process = processLike;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    processLike.stdout.on('data', (chunk) => this.#read(String(chunk)));
    processLike.on?.('exit', () => {
      for (const pending of this.pending.values()) pending.reject(new Error('runtime_exited'));
      this.pending.clear();
    });
  }

  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.process.stdin.write(`${encode({ id, method, params })}\n`);
    });
  }

  close() { this.process.kill?.(); }

  #read(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? '';
    for (const line of lines.filter(Boolean)) {
      let response;
      try { response = JSON.parse(line); } catch { continue; }
      const pending = this.pending.get(response.id);
      if (!pending) continue;
      this.pending.delete(response.id);
      pending.resolve({ ok: response.ok, ...(response.result === undefined ? {} : { result: response.result }), ...(response.error === undefined ? {} : { error: response.error }) });
    }
  }
}
