process.parentPort.postMessage({ type: process.type, node: process.versions.node, electron: process.versions.electron });
process.exit(0);
