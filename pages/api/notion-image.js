import sharp from 'sharp'

export const config = {
  api: {
    // 图片二进制可能超过默认 4MB 响应限制
    responseLimit: false
  },
  maxDuration: 30
}

// 只代理 Notion 官方文件 CDN，避免被当作开放代理（SSRF）
const ALLOWED_HOSTS = new Set(['file.notion.com', 'file.notion.so'])
const ALLOWED_PATH_PREFIX = '/f/f/'
const MAX_SOURCE_BYTES = 20 * 1024 * 1024
const MAX_OUTPUT_WIDTH = 2400
const DEFAULT_WIDTH = 1080
const DEFAULT_QUALITY = 80
const UPSTREAM_TIMEOUT_MS = 15000

/**
 * 校验并解析来源地址，非法地址返回 null
 */
function parseSourceUrl(value) {
  if (typeof value !== 'string' || !value) {
    return null
  }

  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      !ALLOWED_HOSTS.has(url.hostname) ||
      !url.pathname.startsWith(ALLOWED_PATH_PREFIX)
    ) {
      return null
    }
    return url
  } catch {
    return null
  }
}

function parsePositiveInt(value, fallback, max) {
  // 重复的查询参数会被 Next 解析成数组，这里只接受单值
  if (Array.isArray(value)) {
    return fallback
  }
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }
  return Math.min(parsed, max)
}

// 这些格式转成静态 WebP 会丢帧或丢失矢量特性，直接透传原图
const PASSTHROUGH_CONTENT_TYPES = new Set(['image/svg+xml', 'image/gif'])

function normalizeContentType(header) {
  if (typeof header !== 'string' || !header) {
    return ''
  }
  return header.split(';')[0].trim().toLowerCase()
}

function sendImage(res, buffer, contentType, cacheControl) {
  res.setHeader('Cache-Control', cacheControl)
  res.setHeader('Content-Type', contentType || 'application/octet-stream')
  res.setHeader('Content-Length', buffer.length)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  // 不返回响应对象，避免 Next 认为 handler 返回了值
  res.status(200).send(buffer)
}

/**
 * 压缩失败时回退到 Notion 签名直链，保证图片仍然可见
 */
function fallbackToSource(res, sourceUrl) {
  res.setHeader('Cache-Control', 'no-store')
  res.redirect(302, sourceUrl.toString())
}

async function fetchSource(sourceUrl) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)
  try {
    const response = await fetch(sourceUrl, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        Accept: 'image/avif,image/webp,image/jpeg,image/png,image/*;q=0.8',
        'User-Agent': 'NotionNext-ImageCompressor'
      }
    })
    if (!response.ok) {
      return { error: `upstream ${response.status}` }
    }
    // 先按 Content-Length 拦截超大文件，避免把内存撑爆
    const declaredLength = Number(response.headers.get('content-length') || 0)
    if (Number.isFinite(declaredLength) && declaredLength > MAX_SOURCE_BYTES) {
      return { error: `upstream too large: ${declaredLength}` }
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    if (!buffer.length) {
      return { error: 'upstream empty body' }
    }
    if (buffer.length > MAX_SOURCE_BYTES) {
      return { error: `upstream too large: ${buffer.length}` }
    }
    return {
      buffer,
      contentType: normalizeContentType(response.headers.get('content-type'))
    }
  } catch (error) {
    return { error: error?.message || String(error) }
  } finally {
    clearTimeout(timer)
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method Not Allowed' })
  }

  const sourceUrl = parseSourceUrl(req.query.url)
  if (!sourceUrl) {
    return res.status(400).json({ error: 'Invalid Notion image URL' })
  }

  const width = parsePositiveInt(req.query.w, DEFAULT_WIDTH, MAX_OUTPUT_WIDTH)
  const quality = parsePositiveInt(req.query.q, DEFAULT_QUALITY, 100)

  const source = await fetchSource(sourceUrl)
  if (source.error) {
    console.warn('[notion-image] fetch failed:', source.error)
    return fallbackToSource(res, sourceUrl)
  }

  const { buffer, contentType } = source
  // 压缩产物会被 CDN 与浏览器长期缓存，来源地址本身带签名，天然唯一
  const cacheControl = 'public, max-age=31536000, s-maxage=31536000, immutable'

  if (PASSTHROUGH_CONTENT_TYPES.has(contentType)) {
    return sendImage(res, buffer, contentType, cacheControl)
  }

  try {
    const image = sharp(buffer, { failOn: 'none' })
    const metadata = await image.metadata()

    // 兜底：Content-Type 缺失或不准时，用多帧特征识别动图
    if ((metadata.pages || 1) > 1 || metadata.format === 'gif') {
      return sendImage(
        res,
        buffer,
        contentType || `image/${metadata.format}`,
        cacheControl
      )
    }

    const output = await image
      .rotate() // 按 EXIF 方向校正
      .resize({ width, withoutEnlargement: true })
      .webp({ quality })
      .toBuffer()

    // 原图已经比压缩结果更小时，压缩没有意义
    if (output.length >= buffer.length) {
      return sendImage(
        res,
        buffer,
        contentType || `image/${metadata.format}`,
        cacheControl
      )
    }

    return sendImage(res, output, 'image/webp', cacheControl)
  } catch (error) {
    console.error('[notion-image] compress failed:', error?.message || error)
    return fallbackToSource(res, sourceUrl)
  }
}
