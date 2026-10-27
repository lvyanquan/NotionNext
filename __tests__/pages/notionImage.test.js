/** @jest-environment node */
import crypto from 'crypto'
import handler, { config } from '@/pages/api/notion-image'
import sharp from 'sharp'

const signedUrl =
  'https://file.notion.com/f/f/space-id/attachment-id/photo.png' +
  '?table=block&id=block-1&expirationTimestamp=1792072800000&signature=test-signature'

const createRes = () => ({
  headers: {},
  setHeader(name, value) {
    this.headers[name.toLowerCase()] = value
  },
  status(code) {
    this.code = code
    return this
  },
  json(body) {
    this.body = body
    return this
  },
  send(body) {
    this.body = body
    return this
  },
  redirect(code, location) {
    this.code = code
    this.location = location
    return this
  }
})

// 纯色图 PNG 体积极小，可能比 WebP 还小而触发“原图更小则透传”分支；
// 这里用随机噪声保证源图确实需要压缩。
const createPng = (width, height = 600) =>
  sharp(crypto.randomBytes(width * height * 3), {
    raw: { width, height, channels: 3 }
  })
    .png()
    .toBuffer()

const toArrayBuffer = buffer => new Uint8Array(buffer).buffer

const mockUpstream = (buffer, contentType = 'image/png', status = 200) => {
  global.fetch = jest.fn(() =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers({ 'content-type': contentType }),
      arrayBuffer: () => Promise.resolve(toArrayBuffer(buffer))
    })
  )
}

const originalFetch = global.fetch

afterEach(() => {
  global.fetch = originalFetch
  delete process.env.EXPORT
})

it('图片接口运行在 Node runtime 且不超过 Hobby 时长上限', () => {
  expect(config.maxDuration).toBeLessThanOrEqual(60)
  expect(config.api.responseLimit).toBe(false)
})

it('只接受 GET 请求', async () => {
  const res = createRes()
  await handler({ method: 'POST', query: { url: signedUrl } }, res)

  expect(res.code).toBe(405)
  expect(res.headers.allow).toBe('GET')
})

describe('来源地址校验（防 SSRF）', () => {
  it.each([
    ['缺失 url', undefined],
    ['重复 url 参数', [signedUrl, signedUrl]],
    ['非 URL 字符串', 'not-a-url'],
    ['http 协议', signedUrl.replace('https://', 'http://')],
    ['其他域名', 'https://evil.example.com/f/f/a/b/photo.png'],
    ['Notion 其他路径', 'https://file.notion.com/image/percent/photo.png']
  ])('拒绝 %s', async (_name, url) => {
    global.fetch = jest.fn()
    const res = createRes()
    await handler({ method: 'GET', query: { url } }, res)

    expect(res.code).toBe(400)
    expect(global.fetch).not.toHaveBeenCalled()
  })
})

describe('压缩输出', () => {
  it('默认压缩为 WebP 并带长期缓存头', async () => {
    const source = await createPng(2000)
    mockUpstream(source)
    const res = createRes()

    await handler({ method: 'GET', query: { url: signedUrl } }, res)

    expect(res.code).toBe(200)
    expect(res.headers['content-type']).toBe('image/webp')
    expect(res.headers['cache-control']).toContain('immutable')
    expect(res.body.length).toBeLessThan(source.length)

    const metadata = await sharp(res.body).metadata()
    expect(metadata.format).toBe('webp')
    // 未指定宽度时使用默认 1080
    expect(metadata.width).toBe(1080)
  })

  it('按 w 参数压缩，且不超过 2400 上限', async () => {
    const source = await createPng(2600, 200)
    mockUpstream(source)
    const narrow = createRes()
    const capped = createRes()

    await handler(
      { method: 'GET', query: { url: signedUrl, w: '640' } },
      narrow
    )
    await handler(
      { method: 'GET', query: { url: signedUrl, w: '99999' } },
      capped
    )

    expect((await sharp(narrow.body).metadata()).width).toBe(640)
    expect((await sharp(capped.body).metadata()).width).toBe(2400)
  })

  it('小图不被放大', async () => {
    const source = await createPng(400, 300)
    mockUpstream(source)
    const res = createRes()

    await handler({ method: 'GET', query: { url: signedUrl, w: '1080' } }, res)

    expect((await sharp(res.body).metadata()).width).toBe(400)
  })

  it.each([
    ['image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"/>'],
    ['image/gif', 'GIF89a-fake-animated-frames']
  ])('%s 原样透传，不做栅格化', async (contentType, body) => {
    const source = Buffer.from(body)
    mockUpstream(source, contentType)
    const res = createRes()

    await handler({ method: 'GET', query: { url: signedUrl } }, res)

    expect(res.code).toBe(200)
    expect(res.headers['content-type']).toBe(contentType)
    expect(res.body).toEqual(source)
  })
})

describe('失败回退', () => {
  it('上游异常时 302 回退到 Notion 签名直链', async () => {
    global.fetch = jest.fn(() => Promise.reject(new Error('network down')))
    const res = createRes()

    await handler({ method: 'GET', query: { url: signedUrl } }, res)

    expect(res.code).toBe(302)
    expect(res.location).toBe(signedUrl)
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it.each([403, 404, 500])('上游返回 %s 时回退到直链', async status => {
    mockUpstream(Buffer.from('denied'), 'text/plain', status)
    const res = createRes()

    await handler({ method: 'GET', query: { url: signedUrl } }, res)

    expect(res.code).toBe(302)
    expect(res.location).toBe(signedUrl)
  })

  it('无法解码的图片回退到直链而不是报 500', async () => {
    mockUpstream(Buffer.from('this is not an image'), 'image/png')
    const res = createRes()

    await handler({ method: 'GET', query: { url: signedUrl } }, res)

    expect(res.code).toBe(302)
    expect(res.location).toBe(signedUrl)
  })

  it('上游声明超过 20MB 时直接回退，不读完整响应体', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({
          'content-type': 'image/png',
          'content-length': String(21 * 1024 * 1024)
        }),
        arrayBuffer: () => Promise.resolve(toArrayBuffer(Buffer.alloc(1)))
      })
    )
    const res = createRes()

    await handler({ method: 'GET', query: { url: signedUrl } }, res)

    expect(res.code).toBe(302)
    expect(res.location).toBe(signedUrl)
  })
})
