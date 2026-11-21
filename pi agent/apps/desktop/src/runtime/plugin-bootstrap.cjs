'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { types } = require('node:util');
const request = JSON.parse(fs.readFileSync(path.join(__dirname, 'input.json'), 'utf8'));
let response;
try {
  const context = vm.createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
    microtaskMode: 'afterEvaluate'
  });
  // Capture realm intrinsics before evaluating plugin code. Validation and traversal
  // stay in the time-limited context and never invoke getters or toJSON hooks.
  const makeSerializer = new vm.Script(`((isPromise, isProxy) => {
    const ownKeys = Reflect.ownKeys;
    const descriptors = Object.getOwnPropertyDescriptors;
    const hasOwn = Object.hasOwn;
    const prototypeOf = Object.getPrototypeOf;
    const objectPrototype = Object.prototype;
    const isArray = Array.isArray;
    const isFinite = Number.isFinite;
    const stringify = JSON.stringify;
    const InvalidOutput = Error;
    return (plugin, input) => {
      const output = plugin(input);
      let nodes = 0;
      function visit(value, depth) {
        if (++nodes > 4096 || depth > 12) throw new InvalidOutput('plugin_output_invalid');
        if (value === null || typeof value === 'boolean') return stringify(value);
        if (typeof value === 'string') {
          if (value.length > 32768) throw new InvalidOutput('plugin_output_invalid');
          return stringify(value);
        }
        if (typeof value === 'number' && isFinite(value)) return stringify(value);
        if (!value || typeof value !== 'object' || isPromise(value) || isProxy(value)) throw new InvalidOutput('plugin_output_invalid');
        const array = isArray(value);
        if (!array && prototypeOf(value) !== objectPrototype && prototypeOf(value) !== null) {
          throw new InvalidOutput('plugin_output_invalid');
        }
        const properties = descriptors(value);
        const keys = ownKeys(properties);
        let result = array ? '[' : '{';
        if (array) {
          const length = properties.length.value;
          if (length > 4096 || keys.length !== length + 1) throw new InvalidOutput('plugin_output_invalid');
          for (let i = 0; i < length; i++) {
            const property = properties[i];
            if (!hasOwn(properties, i) || !property.enumerable || !hasOwn(property, 'value')) throw new InvalidOutput('plugin_output_invalid');
            if (i) result += ',';
            result += visit(property.value, depth + 1);
            if (result.length > 32768) throw new InvalidOutput('plugin_output_invalid');
          }
        } else {
          for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            const property = properties[key];
            if (typeof key !== 'string' || key === '__proto__' || key === 'constructor' || key === 'prototype' ||
                !property.enumerable || !hasOwn(property, 'value')) throw new InvalidOutput('plugin_output_invalid');
            if (i) result += ',';
            result += stringify(key) + ':' + visit(property.value, depth + 1);
            if (result.length > 32768) throw new InvalidOutput('plugin_output_invalid');
          }
        }
        return result + (array ? ']' : '}');
      }
      return visit(output, 0);
    };
  })`).runInContext(context, { timeout: request.executionMs });
  const serialize = makeSerializer(types.isPromise, types.isProxy);
  Object.defineProperty(context, '__serializePluginJson', { value: serialize });
  const plugin = new vm.Script('(' + request.source + '\n)').runInContext(context, { timeout: request.executionMs });
  if (typeof plugin !== 'function') throw Error('plugin_execution_failed');
  Object.defineProperty(context, '__plugin', { value: plugin });
  const script = new vm.Script('__serializePluginJson(__plugin, ' + JSON.stringify(request.input) + ')');
  const result = script.runInContext(context, { timeout: request.executionMs });
  if (typeof result !== 'string' || Buffer.byteLength(result) > 32768) throw Error('plugin_output_invalid');
  response = { ok: true, output: JSON.parse(result) };
} catch (cause) {
  // Arbitrary thrown plugin objects can contain hostile accessors or proxy traps.
  // Read data descriptors only on native Errors and never evaluate their properties.
  const code = types.isNativeError(cause) ? Object.getOwnPropertyDescriptor(cause, 'code')?.value : undefined;
  const message = types.isNativeError(cause) ? Object.getOwnPropertyDescriptor(cause, 'message')?.value : undefined;
  response = { ok: false, code: code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ? 'plugin_timeout' : message === 'plugin_output_invalid' ? 'plugin_output_invalid' : 'plugin_execution_failed' };
}
fs.writeFileSync(path.join(__dirname, 'output', 'result.json'), JSON.stringify(response), { encoding: 'utf8', flag: 'wx' });
// No asynchronous plugin work survives the synchronous request, including rejected promises.
process.exit(0);