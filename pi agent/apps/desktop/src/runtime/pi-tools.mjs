import { DocumentReader } from './document-reader.mjs';
import { ImageReader } from './image-reader.mjs';

function textResult(text, details = {}) {
  return { content: [{ type: 'text', text }], details };
}

function assertWorkspaceReadAllowed(permissionGateway, contract) {
  const decision = permissionGateway.check('workspace.read', contract, {});
  if (!decision.allowed) throw Object.assign(new Error('workspace_read_not_approved'), { code: 'workspace_read_not_approved' });
}

export function createWorkspaceTools({ workspace, permissionGateway, contract, artifacts, supportsImages = false, sanitize = (value) => value, recordSource = () => {}, ensureAuthorized = async () => {} }) {
  const reader = new DocumentReader();
  const sources = new Map();
  const remember = (source) => {
    const previous = sources.get(source.path);
    if (previous?.sha256 === source.sha256 && previous.pages && source.pages) {
      source = { ...source, pages: [...new Set([...previous.pages, ...source.pages])].sort((left, right) => left - right) };
    }
    sources.set(source.path, source);
    recordSource(source);
  };
  const check = async () => { await ensureAuthorized(); assertWorkspaceReadAllowed(permissionGateway, contract); };
  const tools = [
    {
      name: 'workspace_list',
      label: '列举工作区',
      description: '列举授权工作区中指定目录的直接子项。只能读取，不能修改文件。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '工作区内的相对目录路径；省略表示工作区根目录。' }
        },
        additionalProperties: false
      },
      executionMode: 'sequential',
      execute: async (_toolCallId, params) => {
        await check();
        const result = await workspace.list(params?.path ?? '.');
        await check();
        return textResult(JSON.stringify(result), {
          operation: 'list',
          status: result.status,
          entryCount: result.entries?.length ?? 0,
          truncated: Boolean(result.truncated)
        });
      }
    },
    {
      name: 'workspace_read',
      label: '读取工作区文本',
      description: '读取授权工作区内的一个 UTF-8 文本文件。只能读取，不能修改文件。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '工作区内的相对文本文件路径。' }
        },
        required: ['path'],
        additionalProperties: false
      },
      executionMode: 'sequential',
      execute: async (_toolCallId, params) => {
        await check();
        const result = await workspace.readText(params.path);
        await check();
        if (result.status === 'ok') remember({ path: params.path, format: 'text', sha256: result.sha256, size: result.size });
        return textResult(result.status === 'ok' ? result.data : JSON.stringify(result), {
          operation: 'read',
          status: result.status,
          size: result.size ?? 0
        });
      }
    },
    {
      name: 'workspace_read_document',
      label: '读取工作区资料',
      description: '提取授权目录内 PDF、DOCX、TXT 或 Markdown 的文本，返回来源和 PDF 页码。PDF 每次最多 20 页，文本最多 60000 字符，扫描 PDF 可能无文本。',
      parameters: {
        type: 'object', properties: {
          path: { type: 'string', description: '资料的相对路径。' },
          startPage: { type: 'integer', minimum: 1, description: 'PDF 起始页码，从 1 开始。' },
          pageCount: { type: 'integer', minimum: 1, maximum: 20, description: 'PDF 本次读取页数。' }
        }, required: ['path'], additionalProperties: false
      },
      executionMode: 'sequential',
      execute: async (_id, params) => {
        await check();
        const result = await reader.read(workspace, params.path, { startPage: params.startPage, pageCount: params.pageCount });
        await check();
        if (result.status === 'ok') remember(result.source);
        return textResult(JSON.stringify(result), { operation: 'read_document', status: result.status, size: result.source.size, truncated: result.truncated });
      }
    }
  ];
  if (supportsImages) {
    const imageReader = new ImageReader();
    tools.push({
      name: 'workspace_read_image',
      label: '查看工作区图片',
      description: '读取已授权目录内 JPEG、PNG、WebP 或 GIF，提交实际图片像素并记录来源。最多 10 MiB 和 1600 万像素，按方向旋转并缩放到长边 1600 像素。多帧图片只读取首帧，细节不清时应说明无法核实。',
      parameters: { type: 'object', properties: { path: { type: 'string', description: '图片的相对路径。' } }, required: ['path'], additionalProperties: false },
      executionMode: 'sequential',
      execute: async (_id, params) => {
        await check();
        const result = await imageReader.read(workspace, params.path);
        await check();
        remember(result.source);
        return {
          content: [{ type: 'text', text: JSON.stringify({ status: result.status, source: result.source }) }, result.image],
          details: { operation: 'read_image', status: result.status, size: result.source.size }
        };
      }
    });
  }
  if (artifacts) tools.push({
    name: 'workspace_prepare_text', label: '准备文本产物',
    description: '准备 TXT 或 Markdown 产物并提交用户查看。提供相对路径、完整正文及本轮已读取的 sourcePaths。用户确认创建后写入工作区，已有文件会报冲突。',
    parameters: { type: 'object', properties: {
      path: { type: 'string' }, content: { type: 'string' },
      sourcePaths: { type: 'array', items: { type: 'string' }, maxItems: 32 }
    }, required: ['path', 'content', 'sourcePaths'], additionalProperties: false },
    executionMode: 'sequential',
    execute: async (_id, params) => {
      await check();
      if (!Array.isArray(params.sourcePaths) || params.sourcePaths.length > 32 || params.sourcePaths.some((name) => !sources.has(name))) throw Error('artifact_source_not_read');
      const item = await artifacts.prepare(sanitize({ path: params.path, content: params.content }), sanitize([...new Set(params.sourcePaths)].map((name) => sources.get(name))));
      return textResult(JSON.stringify({ id: item.id, path: item.path, status: item.status, sha256: item.sha256, message: '请用户在文件产物面板查看并确认创建。' }), { operation: 'prepare_text', status: item.status, size: Buffer.byteLength(item.content) });
    }
  });
  return tools;
}
