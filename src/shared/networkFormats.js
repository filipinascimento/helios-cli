export const HELIOS_NETWORK_FORMATS = Object.freeze({
  bxnet: Object.freeze({
    id: 'bxnet',
    extension: '.bxnet',
    mimeType: 'application/vnd.helios.bxnet',
    label: 'Helios Binary Network',
  }),
  zxnet: Object.freeze({
    id: 'zxnet',
    extension: '.zxnet',
    mimeType: 'application/vnd.helios.zxnet',
    label: 'Helios Compressed Network',
  }),
  xnet: Object.freeze({
    id: 'xnet',
    extension: '.xnet',
    mimeType: 'application/vnd.helios.xnet',
    label: 'Helios XNet Network',
  }),
  gml: Object.freeze({
    id: 'gml',
    extension: '.gml',
    mimeType: 'application/gml+xml',
    label: 'Graph Modeling Language Network',
  }),
  gt: Object.freeze({
    id: 'gt',
    extension: '.gt',
    extensions: Object.freeze(['.gt', '.gt.zst']),
    mimeType: 'application/vnd.graph-tool.gt',
    label: 'Graph-tool Network',
  }),
});

export const HELIOS_NETWORK_EXTENSIONS = Object.freeze(
  Object.values(HELIOS_NETWORK_FORMATS).flatMap((entry) => entry.extensions ?? [entry.extension]),
);

export function inferNetworkFormat(filePath, fallback = 'bxnet') {
  const normalizedPath = String(filePath ?? '').toLowerCase();
  for (const format of Object.values(HELIOS_NETWORK_FORMATS)) {
    const extensions = format.extensions ?? [format.extension];
    if (extensions.some((extension) => normalizedPath.endsWith(extension))) return format.id;
  }
  return fallback;
}

export function isHeliosNetworkPath(filePath) {
  const normalizedPath = String(filePath ?? '').toLowerCase();
  return HELIOS_NETWORK_EXTENSIONS.some((extension) => normalizedPath.endsWith(extension));
}

export function networkMimeTypeForFormat(format) {
  return HELIOS_NETWORK_FORMATS[format]?.mimeType ?? 'application/octet-stream';
}
