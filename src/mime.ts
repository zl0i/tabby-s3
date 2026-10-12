const TYPES: Record<string, string> = {
    // Text and code
    txt: 'text/plain',
    log: 'text/plain',
    md: 'text/markdown',
    csv: 'text/csv',
    tsv: 'text/tab-separated-values',
    html: 'text/html',
    htm: 'text/html',
    css: 'text/css',
    js: 'text/javascript',
    mjs: 'text/javascript',
    json: 'application/json',
    map: 'application/json',
    xml: 'application/xml',
    yaml: 'application/yaml',
    yml: 'application/yaml',
    toml: 'application/toml',
    wasm: 'application/wasm',
    // Images
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    bmp: 'image/bmp',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    // Audio and video
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    flac: 'audio/flac',
    m4a: 'audio/mp4',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    mkv: 'video/x-matroska',
    avi: 'video/x-msvideo',
    m3u8: 'application/vnd.apple.mpegurl',
    ts: 'video/mp2t',
    // Fonts
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    otf: 'font/otf',
    // Documents and archives
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    zip: 'application/zip',
    gz: 'application/gzip',
    tgz: 'application/gzip',
    tar: 'application/x-tar',
    bz2: 'application/x-bzip2',
    xz: 'application/x-xz',
    '7z': 'application/x-7z-compressed',
    rar: 'application/vnd.rar',
}

/** Guesses a Content-Type from the file extension, so that served files open in browsers instead of downloading */
export function guessContentType (name: string): string {
    const dot = name.lastIndexOf('.')
    const extension = dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
    return TYPES[extension] ?? 'application/octet-stream'
}
