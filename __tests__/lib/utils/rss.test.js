import fs from 'fs'
import ReactDOMServer from 'react-dom/server'
import { generateRss, shouldGenerateRssForLocale } from '@/lib/utils/rss'
import { getPostBlocks } from '@/lib/db/SiteDataApi'
import { formatNotionBlock } from '@/lib/db/notion/getPostBlocks'
import { adapterNotionBlockMap } from '@/lib/utils/notion.util'

const addItemMock = jest.fn()
const rss2Mock = jest.fn(() => '<rss>ok</rss>')
const atom1Mock = jest.fn(() => '<atom>ok</atom>')
const json1Mock = jest.fn(() => '{"ok":true}')

jest.mock('feed', () => ({
  Feed: jest.fn().mockImplementation(() => ({
    addItem: addItemMock,
    rss2: rss2Mock,
    atom1: atom1Mock,
    json1: json1Mock
  }))
}))

jest.mock('react-dom/server', () => ({
  __esModule: true,
  default: {
    renderToString: jest.fn(() => '<div>rss-content</div>')
  }
}))

jest.mock('@/components/NotionPage', () => ({
  __esModule: true,
  default: () => null
}))

jest.mock('@/lib/db/SiteDataApi', () => ({
  getPostBlocks: jest.fn()
}))

jest.mock('@/lib/db/notion/getPostBlocks', () => ({
  formatNotionBlock: jest.fn(block => block)
}))

jest.mock('@/lib/utils/notion.util', () => ({
  adapterNotionBlockMap: jest.fn(blockMap => blockMap)
}))

describe('generateRss', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.spyOn(fs, 'statSync').mockImplementation(() => {
      throw new Error('ENOENT')
    })
    jest.spyOn(fs, 'mkdirSync').mockImplementation(() => {})
    jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {})
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('adapts and formats blockMap before rendering RSS content', async () => {
    const rawBlockMap = {
      block: {
        x1: { id: 'x1', type: 'text' }
      }
    }
    const adaptedBlockMap = {
      block: {
        y1: { id: 'y1', type: 'text' }
      }
    }
    const formattedBlock = {
      y1: { id: 'y1', type: 'text', properties: {} }
    }

    getPostBlocks.mockResolvedValue(rawBlockMap)
    adapterNotionBlockMap.mockReturnValue(adaptedBlockMap)
    formatNotionBlock.mockReturnValue(formattedBlock)

    await generateRss({
      NOTION_CONFIG: {
        AUTHOR: 'author',
        LANG: 'zh-CN',
        SUB_PATH: '',
        CONTACT_EMAIL: ''
      },
      siteInfo: {
        title: 'site',
        description: 'desc',
        link: 'https://example.com'
      },
      latestPosts: [
        {
          id: 'post-1',
          slug: 'hello',
          title: 'Hello',
          summary: 'Summary',
          publishDay: '2026-02-18'
        }
      ]
    })

    expect(getPostBlocks).toHaveBeenCalledWith('post-1', 'rss-content')
    expect(adapterNotionBlockMap).toHaveBeenCalledWith(rawBlockMap)
    expect(formatNotionBlock).toHaveBeenCalledWith(
      expect.objectContaining({
        y1: expect.objectContaining({ id: 'y1', type: 'text' })
      })
    )
    expect(addItemMock).toHaveBeenCalledWith(
      expect.objectContaining({
        content: '<div>rss-content</div>'
      })
    )
    expect(fs.writeFileSync).toHaveBeenCalledTimes(3)
  })

  it('RSS 全文中的站内相对地址补全为绝对地址', async () => {
    ReactDOMServer.renderToString.mockReturnValueOnce(
      '<figure>' +
        '<img src="/api/notion-image?url=https%3A%2F%2Ffile.notion.com%2Ff%2Ff%2Fa" data-src="/api/notion-image?a=1"/>' +
        '<a href="/hello">link</a>' +
        '<img src="https://cdn.example.com/a.png"/>' +
        '<img src="//protocol-relative.example.com/b.png"/>' +
        '</figure>'
    )
    getPostBlocks.mockResolvedValue({
      block: { x1: { id: 'x1', type: 'text' } }
    })

    await generateRss({
      NOTION_CONFIG: {
        AUTHOR: 'author',
        LANG: 'zh-CN',
        SUB_PATH: '',
        CONTACT_EMAIL: ''
      },
      siteInfo: {
        title: 'site',
        description: 'desc',
        link: 'https://example.com'
      },
      latestPosts: [
        {
          id: 'post-1',
          slug: 'hello',
          title: 'Hello',
          summary: 'Summary',
          publishDay: '2026-10-27'
        }
      ]
    })

    const { content } = addItemMock.mock.calls[0][0]
    // 站内压缩接口与站内链接补全为绝对地址，RSS 阅读器才能解析
    expect(content).toContain(
      'src="https://example.com/api/notion-image?url=https%3A%2F%2Ffile.notion.com%2Ff%2Ff%2Fa"'
    )
    expect(content).toContain(
      'data-src="https://example.com/api/notion-image?a=1"'
    )
    expect(content).toContain('href="https://example.com/hello"')
    // 外链与协议相对地址保持原样
    expect(content).toContain('src="https://cdn.example.com/a.png"')
    expect(content).toContain('src="//protocol-relative.example.com/b.png"')
  })

  it('uses summary without fetching blocks when RSS_FULL_CONTENT is disabled', async () => {
    await generateRss({
      NOTION_CONFIG: {
        AUTHOR: 'author',
        LANG: 'zh-CN',
        SUB_PATH: '',
        CONTACT_EMAIL: '',
        RSS_FULL_CONTENT: 'false'
      },
      siteInfo: {
        title: 'site',
        description: 'desc',
        link: 'https://example.com'
      },
      latestPosts: [
        {
          id: 'post-1',
          slug: 'hello',
          title: 'Hello',
          summary: 'Summary',
          publishDay: '2026-08-25'
        }
      ]
    })

    expect(getPostBlocks).not.toHaveBeenCalled()
    expect(adapterNotionBlockMap).not.toHaveBeenCalled()
    expect(formatNotionBlock).not.toHaveBeenCalled()
    expect(addItemMock).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'Summary',
        content: 'Summary'
      })
    )
    expect(fs.writeFileSync).toHaveBeenCalledTimes(3)
  })

  it('generates RSS only for the default locale during multi-locale builds', () => {
    expect(shouldGenerateRssForLocale({ locale: undefined })).toBe(true)
    expect(
      shouldGenerateRssForLocale({ locale: 'zh-CN', defaultLocale: 'zh-CN' })
    ).toBe(true)
    expect(
      shouldGenerateRssForLocale({ locale: 'en', defaultLocale: 'zh-CN' })
    ).toBe(false)
  })
})
