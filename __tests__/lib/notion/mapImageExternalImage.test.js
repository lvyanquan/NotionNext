/**
 * @jest-environment node
 */

import { compressImage, mapImgUrl } from '@/lib/db/notion/mapImage'
import { siteConfig } from '@/lib/config'
import BLOG from '@/blog.config'

// issue 作者站点上被 Referer 防盗链拒绝的 smzdm 外链图
const hotlinkBlockedUrl =
  'https://am.zdmimg.com/202312/05/656f0a6482fbc4851.png_e1080.jpg'

const imageBlock = id => ({
  type: 'image',
  id,
  properties: { source: [['<SOURCE>']] }
})

const originalImageConfig = {
  NOTION_HOST: BLOG.NOTION_HOST,
  RANDOM_IMAGE_URL: BLOG.RANDOM_IMAGE_URL,
  RANDOM_IMAGE_REPLACE_TEXT: BLOG.RANDOM_IMAGE_REPLACE_TEXT,
  IMAGE_AUTO_COMPRESS: BLOG.IMAGE_AUTO_COMPRESS
}

const proxySource = image =>
  decodeURIComponent(new URL(image).pathname.split('/image/')[1])

describe('mapImgUrl 外链图片', () => {
  beforeEach(() => {
    // 关闭随机图替换，聚焦外链转换逻辑
    BLOG.RANDOM_IMAGE_URL = ''
  })

  afterEach(() => {
    Object.assign(BLOG, originalImageConfig)
  })

  it('普通外链 image 块走 Notion /image/ 中转，避免源站 Referer 防盗链', () => {
    const block = imageBlock('block-id-1')
    const ret = mapImgUrl(hotlinkBlockedUrl, block, 'block', false)

    expect(ret).toContain(`${BLOG.NOTION_HOST}/image/`)
    expect(ret).toContain(encodeURIComponent(hotlinkBlockedUrl))
    expect(ret).toContain('table=block')
    expect(ret).toContain('id=block-id-1')
    // 原始外链不应直接出现（直出会被源站防盗链拒绝）
    expect(ret).not.toContain(hotlinkBlockedUrl)
  })

  it('page 类型封面的外链图同样走中转', () => {
    const block = {
      type: 'page',
      id: 'page-id-1',
      format: { page_cover: hotlinkBlockedUrl }
    }
    const ret = mapImgUrl(hotlinkBlockedUrl, block, 'collection', false)

    expect(ret).toContain(`${BLOG.NOTION_HOST}/image/`)
  })

  it('Notion 自有资源保持原有转换行为', () => {
    const block = imageBlock('block-id-2')
    const secureUrl = 'https://secure.notion-static.com/abc123/photo.png'
    const ret = mapImgUrl(secureUrl, block, 'block', false)

    expect(ret).toContain(`${BLOG.NOTION_HOST}/image/`)
  })

  describe('Notion 新文件 CDN 自动压缩', () => {
    const signedUrlOf = host =>
      `https://${host}/f/f/space-id/attachment-id/photo.jpg` +
      '?table=block&id=signed-image&expirationTimestamp=1792072800000&signature=test-signature'

    const paramsOf = ret => new URL(ret, 'http://local').searchParams

    it.each(['file.notion.com', 'file.notion.so'])(
      '%s 默认改走站内压缩接口，不再直出未压缩原图',
      host => {
        const signedUrl = signedUrlOf(host)
        const ret = mapImgUrl(
          signedUrl,
          imageBlock('signed-image'),
          'block',
          false
        )

        expect(ret.startsWith('/api/notion-image?')).toBe(true)
        // 仍不经过 Notion 图片代理：自定义代理域名会被部分办公网络拦截
        expect(ret).not.toContain(`${BLOG.NOTION_HOST}/image/`)

        const params = paramsOf(ret)
        expect(params.get('url')).toBe(signedUrl)
        expect(params.get('w')).toBe(String(siteConfig('IMAGE_COMPRESS_WIDTH')))
        expect(params.get('q')).toBe(
          String(siteConfig('IMAGE_COMPRESS_QUALITY'))
        )
      }
    )

    it('Notion 中的块宽度优先于默认压缩宽度', () => {
      const block = {
        ...imageBlock('signed-image'),
        format: { block_width: 640 }
      }
      const ret = mapImgUrl(
        signedUrlOf('file.notion.com'),
        block,
        'block',
        false
      )

      expect(paramsOf(ret).get('w')).toBe('640')
    })

    it('压缩接口地址不追加 t 去重参数，避免 CDN 缓存碎片化', () => {
      const ret = mapImgUrl(
        signedUrlOf('file.notion.com'),
        imageBlock('signed-image'),
        'block',
        false
      )

      expect(ret).not.toContain('t=signed-image')
    })

    it.each([false, 'false', 0])(
      'IMAGE_AUTO_COMPRESS=%s 时保留签名直链',
      value => {
        BLOG.IMAGE_AUTO_COMPRESS = value
        const signedUrl = signedUrlOf('file.notion.com')
        const ret = mapImgUrl(
          signedUrl,
          imageBlock('signed-image'),
          'block',
          false
        )

        expect(ret).toBe(`${signedUrl}&t=signed-image`)
        expect(ret).not.toContain('/api/notion-image')
      }
    )

    it('静态导出没有服务端接口，保留签名直链', () => {
      const originalExport = process.env.EXPORT
      process.env.EXPORT = 'true'
      try {
        const signedUrl = signedUrlOf('file.notion.so')
        const ret = mapImgUrl(
          signedUrl,
          imageBlock('signed-image'),
          'block',
          false
        )

        expect(ret).toBe(`${signedUrl}&t=signed-image`)
      } finally {
        if (originalExport === undefined) {
          delete process.env.EXPORT
        } else {
          process.env.EXPORT = originalExport
        }
      }
    })

    it('点击放大时只改写宽度，保留已配置的压缩质量', () => {
      const ret = mapImgUrl(
        signedUrlOf('file.notion.com'),
        imageBlock('signed-image'),
        'block',
        false
      )
      const zoomed = compressImage(ret, 1920, 80, 'avif')
      const params = paramsOf(zoomed)

      expect(zoomed.startsWith('/api/notion-image?')).toBe(true)
      expect(params.get('w')).toBe('1920')
      expect(params.get('q')).toBe(String(siteConfig('IMAGE_COMPRESS_QUALITY')))
      expect(params.get('url')).toBe(signedUrlOf('file.notion.com'))
    })
  })

  it('attachment: 标识保持原有转换行为', () => {
    const block = imageBlock('block-id-3')
    const ret = mapImgUrl(
      'attachment:block-id-3:photo.png',
      block,
      'block',
      false
    )

    expect(ret).toContain(`${BLOG.NOTION_HOST}/image/`)
  })

  it('已转换的反代链接不被二次包装', () => {
    const block = imageBlock('block-id-4')
    const alreadyProxied = `${BLOG.NOTION_HOST}/image/${encodeURIComponent(
      hotlinkBlockedUrl
    )}?table=block&id=block-id-4`
    const ret = mapImgUrl(alreadyProxied, block, 'block', false)

    // 不应出现两层 /image/
    const occurrences = ret.split('/image/').length - 1
    expect(occurrences).toBe(1)
  })

  it('中转链接仍带去重参数 t=<blockId>', () => {
    const block = imageBlock('block-id-5')
    const ret = mapImgUrl(hotlinkBlockedUrl, block, 'block', false)

    expect(ret).toContain('t=block-id-5')
  })

  describe('外链压缩参数（回归：代理前需先做源站压缩）', () => {
    const unsplashUrl = 'https://images.unsplash.com/photo-1234567890'

    it('Unsplash 外链 + block_width 走中转后仍保留 width/q/fmt 参数', () => {
      const block = {
        type: 'image',
        id: 'unsplash-1',
        format: { block_width: 800 }
      }
      const ret = mapImgUrl(unsplashUrl, block, 'block', true)

      // 仍走防盗链中转
      expect(ret).toContain(`${BLOG.NOTION_HOST}/image/`)
      // 被编码进代理地址的源 URL 必须带上压缩参数，否则图片不再被压缩
      const encoded = ret.split('/image/')[1].split('?')[0]
      const source = decodeURIComponent(encoded)
      expect(source).toContain('width=800')
      expect(source).toContain('q=50')
      expect(source).toContain('fmt=webp')
      expect(source).toContain('fm=webp')
    })

    it('没有 block_width 时使用配置的默认压缩宽度', () => {
      const block = { type: 'image', id: 'unsplash-2' }
      const ret = mapImgUrl(unsplashUrl, block, 'block', true)

      const source = decodeURIComponent(ret.split('/image/')[1].split('?')[0])
      expect(source).toContain(`width=${siteConfig('IMAGE_COMPRESS_WIDTH')}`)
    })

    it('非 Unsplash 外链的中转行为不受影响', () => {
      const block = {
        type: 'image',
        id: 'smzdm-1',
        format: { block_width: 800 }
      }
      const ret = mapImgUrl(hotlinkBlockedUrl, block, 'block', true)

      expect(ret).toContain(`${BLOG.NOTION_HOST}/image/`)
      // 非 Unsplash 源站没有已知的压缩参数约定，源 URL 应保持原样
      const source = decodeURIComponent(ret.split('/image/')[1].split('?')[0])
      expect(source).toBe(hotlinkBlockedUrl)
    })

    it('needCompress=false 时不追加压缩参数', () => {
      const block = {
        type: 'image',
        id: 'unsplash-3',
        format: { block_width: 800 }
      }
      const ret = mapImgUrl(unsplashUrl, block, 'block', false)

      const source = decodeURIComponent(ret.split('/image/')[1].split('?')[0])
      expect(source).not.toContain('width=800')
    })
  })

  describe('Heo 图片放大后的高清参数', () => {
    it.each([
      'https://www.notion.so',
      'https://notion.example',
      'https://notion.example/proxy'
    ])('通过 %s 代理的 Unsplash 图片仍可放大到高清尺寸', host => {
      BLOG.NOTION_HOST = host
      const block = {
        ...imageBlock('zoom-image'),
        format: { block_width: 400 }
      }
      const thumbnail = mapImgUrl(
        'https://images.unsplash.com/photo-example?crop=faces',
        block
      )
      const zoomed = compressImage(thumbnail, 1920, 80, 'avif')
      const source = new URL(proxySource(zoomed))

      expect(new URL(proxySource(thumbnail)).searchParams.get('width')).toBe(
        '400'
      )
      expect(source.searchParams.get('width')).toBe('1920')
      expect(source.searchParams.get('q')).toBe('80')
      expect(source.searchParams.get('fmt')).toBe('avif')
      expect(source.searchParams.get('fm')).toBe('avif')
      expect(source.searchParams.get('crop')).toBe('faces')
      expect(zoomed.startsWith(`${host}/image/`)).toBe(true)
      expect(new URL(zoomed).search).toBe(new URL(thumbnail).search)
      expect(zoomed.split('/image/')).toHaveLength(2)
      expect(compressImage(zoomed, 1920, 80, 'avif')).toBe(zoomed)
    })

    it('更换代理域名后，旧 Notion 代理地址仍能更新源图并保留外层参数', () => {
      BLOG.NOTION_HOST = 'https://notion.example'
      const source = 'https://images.unsplash.com/photo-example?width=400'
      const image = `https://www.notion.so/image/${encodeURIComponent(source)}?table=block&id=zoom-image&t=zoom-image&cache=v2#preview`
      const zoomed = compressImage(image, 1920)

      expect(new URL(proxySource(zoomed)).searchParams.get('width')).toBe(
        '1920'
      )
      expect(new URL(zoomed).origin).toBe('https://www.notion.so')
      expect(new URL(zoomed).search).toBe(new URL(image).search)
      expect(new URL(zoomed).hash).toBe('#preview')
    })

    it('首次映射关闭压缩时，后续放大仍可指定 Unsplash 高清尺寸', () => {
      const image = mapImgUrl(
        'https://images.unsplash.com/photo-example',
        imageBlock('uncompressed-image'),
        'block',
        false
      )

      expect(new URL(proxySource(image)).searchParams.has('width')).toBe(false)
      expect(
        new URL(proxySource(compressImage(image, 1920))).searchParams.get(
          'width'
        )
      ).toBe('1920')
    })

    it('保留 Notion AWS 图片原有的代理宽度参数', () => {
      const source =
        'https://s3.us-west-2.amazonaws.com/secure.notion-static.com/id/photo.jpg'
      const image = mapImgUrl(source, imageBlock('aws-image'))
      const zoomed = compressImage(image, 1920)

      expect(new URL(zoomed).searchParams.get('width')).toBe('1920')
      expect(new URL(zoomed).searchParams.get('cache')).toBe('v2')
      expect(proxySource(zoomed)).toBe(source)
    })

    it.each([
      encodeURIComponent(hotlinkBlockedUrl),
      'https%3A%2F%2Fimages.unsplash.com%2Fbad%ZZ'
    ])('未知图床或无效编码保持原样：%s', encodedSource => {
      const image = `${BLOG.NOTION_HOST}/image/${encodedSource}?table=block&id=other-image`

      expect(compressImage(image, 1920)).toBe(image)
    })
  })

  describe('随机图片替换规则', () => {
    const original = 'https://old.example/covers/photo.jpg'
    const replacement = 'https://replacement.example/random?category=cover'

    it.each([
      'https://old.example/covers/',
      '/covers/',
      'old.example',
      'unmatched.example,https://old.example/covers/'
    ])('原图匹配 %s 时仍替换为随机图片', match => {
      BLOG.RANDOM_IMAGE_URL = replacement
      BLOG.RANDOM_IMAGE_REPLACE_TEXT = match

      expect(mapImgUrl(original, imageBlock('random-image'))).toBe(
        `${replacement}&t=random-image`
      )
    })

    it('仍支持匹配生成后的 Notion 代理地址', () => {
      BLOG.RANDOM_IMAGE_URL = replacement
      BLOG.RANDOM_IMAGE_REPLACE_TEXT = `${BLOG.NOTION_HOST}/image/`

      expect(mapImgUrl(original, imageBlock('random-image'))).toBe(
        `${replacement}&t=random-image`
      )
    })

    it('不匹配替换规则的外链仍正常走代理', () => {
      BLOG.RANDOM_IMAGE_URL = replacement
      BLOG.RANDOM_IMAGE_REPLACE_TEXT = 'https://another.example/covers/'

      const image = mapImgUrl(original, imageBlock('original-image'))
      expect(image.startsWith(`${BLOG.NOTION_HOST}/image/`)).toBe(true)
      expect(proxySource(image)).toBe(original)
    })

    it.each(['https://www.notion.so/images/page-cover/solid_blue.png', '🌄'])(
      '全部替换模式保留 Notion 内置封面或 emoji：%s',
      image => {
        BLOG.RANDOM_IMAGE_URL = replacement
        BLOG.RANDOM_IMAGE_REPLACE_TEXT = ''

        expect(mapImgUrl(image, imageBlock('builtin-image'))).toBe(image)
      }
    )
  })
})
