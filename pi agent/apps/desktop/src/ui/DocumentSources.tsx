export type DocumentSource = {
  path: string;
  format: string;
  sha256: string;
  size: number;
  pages?: number[];
  truncated?: boolean;
  width?: number;
  height?: number;
  submittedWidth?: number;
  submittedHeight?: number;
  firstFrameOnly?: boolean;
  frames?: number;
};

export function DocumentSources({ sources }: { sources?: DocumentSource[] }) {
  if (!sources?.length) return null;
  return <details className="document-sources">
    <summary>已读取资料 · {sources.length}</summary>
    <ul>{sources.map((source) => <li key={source.path + source.sha256}>
      <strong>{source.path}</strong>
      <span>{source.format.toUpperCase()} · {source.size.toLocaleString()} 字节{source.pages?.length ? ' · 第 ' + source.pages.join('、') + ' 页' : ''}{source.truncated ? ' · 部分内容' : ''}</span>
      {source.width && source.height && <span>原图 {source.width} × {source.height} · 提交 {source.submittedWidth} × {source.submittedHeight} · 已转换为 JPEG{source.firstFrameOnly ? ' · 共 ' + source.frames + ' 帧，本次仅首帧' : ''}</span>}
      <code title="文件 SHA-256">{source.sha256}</code>
    </li>)}</ul>
  </details>;
}
