import BLOG from '@/blog.config'
import { siteConfig } from '../../config'
import { isExport } from '@/lib/utils/buildMode'

const NOTION_FILE_CDN_URL = /^https?:\/\/file\.notion\.(?:com|so)\//i
// 站内图片压缩接口：使用相对路径，浏览器只与本站通信，
// 避免自定义图片代理域名被部分办公网络拦截。
const AUTO_COMPRESS_API = '/api/notion-image'

const isFalseLike = value =>
  value === false || value === 'false' || value === 0 || value === '0'

/**
 * 是否把 Notion 文件 CDN 的图片交给站内接口自动压缩。
 * 静态导出（EXPORT=true）没有服务端接口，只能保留签名直链。
 */
const isAutoCompressEnabled = () =>
  !isExport() && !isFalseLike(siteConfig('IMAGE_AUTO_COMPRESS', true))

/**
 * 生成站内压缩接口地址。
 * 宽度以 IMAGE_COMPRESS_WIDTH 为准；Notion 的 block_width 是编辑器里的
 * CSS 像素，而 styles/notion.css 用 min-width:100% 把图片拉伸到正文宽度，
 * 拿它当像素预算会让高分屏发虚，因此只在块宽度更大时才跟随块宽度。
 * 质量固定使用 IMAGE_COMPRESS_QUALITY，避免被通用压缩逻辑降级。
 */
const buildAutoCompressUrl = (source, block) => {
  const configuredWidth = Number(siteConfig('IMAGE_COMPRESS_WIDTH')) || 1080
  const blockWidth = Number(block?.format?.block_width) || 0
  const width = Math.max(configuredWidth, blockWidth)
  const quality = siteConfig('IMAGE_COMPRESS_QUALITY') || 80
  const params = new URLSearchParams({
    url: source,
    w: String(width),
    q: String(quality)
  })
  return `${AUTO_COMPRESS_API}?${params.toString()}`
}

/**
 * 图片映射
 *
 * @param {*} img 图片地址，可能是相对路径，可能是外链
 * @param {*} block 数据块，可能是单个内容块，可能是Page
 * @param {*} type block 单个内容块 ； collection 集合列表
 * @param {*} from 来自
 * @returns
 */
const mapImgUrl = (img, block, type = 'block', needCompress = true) => {
  if (!img) {
    return null
  }

  let ret = null
  // 相对目录，则视为notion的自带图片
  if (img.startsWith('/')) {
    ret = BLOG.NOTION_HOST + img
  } else {
    ret = img
  }
  const sourceUrl = ret
  // 保留 Notion 新文件 CDN 的签名直链。部分办公网络允许 file.notion.com，
  // 但会拦截 www.notion.so、workers.dev 或自定义图片代理域名。
  // 签名续期仍由 getPostBlocks.js 负责。
  const isNotionFileCdnUrl = NOTION_FILE_CDN_URL.test(ret)
  // 签名直链是未压缩原图（常见 2~3MB），默认改由站内接口在服务端转 WebP。
  if (isNotionFileCdnUrl && isAutoCompressEnabled()) {
    ret = buildAutoCompressUrl(ret, block)
  }

  const hasConverted =
    ret.indexOf('https://www.notion.so/image') === 0 ||
    // 已转换的反代链接不再二次包装
    ret.indexOf(BLOG.NOTION_HOST + '/image/') === 0 ||
    ret.includes('notion.site/images/page-cover/')

  // 需要转化的URL ; 识别aws图床地址，或者bookmark类型的外链图片
  // Notion新图床资源 格式为 attachment:${id}:${name}
  // 外链 http(s) 图片也走 Notion /image/ 中转：直出时浏览器会带上本站
  // Referer，部分图床（如 smzdm）的 Referer 防盗链会直接拒绝（HTTP 567），
  // 而 Notion 原站经 img.notionusercontent.com 服务端转发不受影响。
  const isExternalHttpImage = /^https?:\/\//i.test(ret)
  const needConvert =
    !hasConverted &&
    !isNotionFileCdnUrl &&
    (block.type === 'bookmark' ||
      isExternalHttpImage ||
      ret.includes('secure.notion-static.com') ||
      ret.includes('prod-files-secure') ||
      ret.indexOf('attachment') === 0)

  // 先应用源站压缩参数再交给 Notion 代理；放大时可再次调整源图尺寸。
  if (isExternalHttpImage && needCompress) {
    ret = compressImage(ret, block?.format?.block_width)
  }

  // Notion旧图床
  if (needConvert) {
    ret =
      BLOG.NOTION_HOST +
      '/image/' +
      encodeURIComponent(ret) +
      '?table=' +
      type +
      '&id=' +
      block.id
  }

  if (!isEmoji(ret) && ret.indexOf('notion.so/images/page-cover') < 0) {
    if (BLOG.RANDOM_IMAGE_URL) {
      // 只有配置了随机图片接口，才会替换图片
      const texts = BLOG.RANDOM_IMAGE_REPLACE_TEXT
      let isReplace = false
      if (texts) {
        const textArr = texts.split(',')
        // 原图地址尚未被代理编码，同时兼容既有的代理地址匹配规则。
        textArr.forEach(text => {
          if (sourceUrl.includes(text) || ret.includes(text)) {
            isReplace = true
          }
        })
      } else {
        isReplace = true
      }
      if (isReplace) {
        ret = BLOG.RANDOM_IMAGE_URL
      }
    }

    // 图片url优化，确保每一篇文章的图片url唯一
    if (
      ret &&
      ret.length > 4 &&
      !ret.includes('https://www.notion.so/images/') &&
      // 压缩接口地址本身已唯一，追加 t 参数只会让 CDN 缓存碎片化
      !ret.startsWith(`${AUTO_COMPRESS_API}?`)
    ) {
      // 图片接口拼接唯一识别参数，防止请求的图片被缓，而导致随机结果相同
      const separator = ret.includes('?') ? '&' : '?'
      ret = `${ret.trim()}${separator}t=${block.id}`
    }
  }

  // 统一压缩图片
  if (needCompress) {
    const width = block?.format?.block_width
    ret = compressImage(ret, width)
  }

  return ret
}

/**
 * 是否是emoji图标
 * @param {*} str
 * @returns
 */
function isEmoji(str) {
  const emojiRegex =
    /[\u{1F300}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1F018}-\u{1F270}\u{238C}\u{2B06}\u{2B07}\u{2B05}\u{27A1}\u{2194}-\u{2199}\u{2194}\u{21A9}\u{21AA}\u{2934}\u{2935}\u{25AA}\u{25AB}\u{25FE}\u{25FD}\u{25FB}\u{25FC}\u{25B6}\u{25C0}\u{1F200}-\u{1F251}]/u
  return emojiRegex.test(str)
}

/**
 * 压缩图片
 * 1. Notion图床可以通过指定url-query参数来压缩裁剪图片 例如 ?xx=xx&width=400
 * 2. UnPlash 图片可以通过api q=50 控制压缩质量 width=400 控制图片尺寸
 * @param {*} image
 */
const compressImage = (image, width, quality = 50, fmt = 'webp') => {
  if (!image) {
    return image
  }

  // 站内压缩接口是相对路径，放大/缩小只需改写 w 参数；
  // 质量仍由 IMAGE_COMPRESS_QUALITY 决定，这里不做降级。
  if (image.startsWith(`${AUTO_COMPRESS_API}?`)) {
    try {
      const urlObj = new URL(image, 'http://local')
      const targetWidth = Number(width) || Number(urlObj.searchParams.get('w'))
      if (Number.isFinite(targetWidth) && targetWidth > 0) {
        urlObj.searchParams.set('w', String(targetWidth))
      }
      return `${urlObj.pathname}?${urlObj.searchParams.toString()}`
    } catch (err) {
      console.error('compressImage: invalid auto-compress url:', image, err)
      return image
    }
  }

  if (image.indexOf('http') !== 0) {
    return image
  }

  if (image.includes('.svg')) return image

  if (!width || width === 0) {
    width = siteConfig('IMAGE_COMPRESS_WIDTH')
  }

  let urlObj
  let params
  try {
    urlObj = new URL(image)
    params = new URLSearchParams(urlObj.search)
  } catch (err) {
    // 如果解析失败，尝试 decodeURIComponent 再解析
    try {
      const decoded = decodeURIComponent(image)
      urlObj = new URL(decoded)
      params = new URLSearchParams(urlObj.search)
    } catch (e) {
      console.error('compressImage: Invalid URL:', image, err)
      return image
    }
  }

  // 放大图片时更新代理路径内的源图参数，保留外层 table、id 等代理信息。
  const proxyPrefix = [
    `${BLOG.NOTION_HOST}/image/`,
    'https://www.notion.so/image/'
  ].find(prefix => image.startsWith(prefix))
  if (proxyPrefix) {
    const proxyPath = new URL(proxyPrefix).pathname
    let sourceUrl
    try {
      sourceUrl = decodeURIComponent(urlObj.pathname.slice(proxyPath.length))
    } catch {
      return image
    }
    if (sourceUrl.startsWith('https://images.unsplash.com/')) {
      urlObj.pathname =
        proxyPath +
        encodeURIComponent(compressImage(sourceUrl, width, quality, fmt))
      return urlObj.toString()
    }
  }

  // Notion图床
  if (
    image.indexOf(BLOG.NOTION_HOST) === 0 &&
    image.indexOf('amazonaws.com') > 0
  ) {
    params.set('width', width)
    params.set('cache', 'v2')
    // 生成新的URL
    urlObj.search = params.toString()
    return urlObj.toString()
  } else if (image.indexOf('https://images.unsplash.com/') === 0) {
    // 压缩unsplash图片
    // 将q参数的值替换
    params.set('q', quality)
    // 尺寸
    params.set('width', width)
    // 格式
    params.set('fmt', fmt)
    params.set('fm', fmt)
    // 生成新的URL
    urlObj.search = params.toString()
    return urlObj.toString()
  } else if (image.indexOf('https://your_picture_bed') === 0) {
    // 此处还可以添加您的自定义图传的封面图压缩参数。
    // .e.g
    return 'do_somethin_here'
  }

  return image
}

export { compressImage, mapImgUrl }
