// 回复里的图片发不出去时：旁边的文字照发，全是图则补一句说明；本机表情只放行精确路径。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHub } from '../src/chat/hub.js'
import { normalize } from '../src/core/config.js'
import { assertPublicUrl, fetchImage, fetchLocalAsset, localAssetUrl, setLocalAssetPort } from '../src/core/net.js'
import { OneBotError } from '../src/onebot/client.js'

const PORT = 3180
const HASH12 = '0123456789ab'
const HASH16 = '0123456789abcdef'
const stickerUrl = (kind, hash = HASH12, port = PORT) => `http://127.0.0.1:${port}/x-nekowhale-stickers/${kind}/${hash}.gif`
const GIF = Buffer.from('GIF89a-sticker')

function dayKey(at = new Date()) {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
}
const textsOf = (calls) => calls.flatMap((c) => c.params.message.filter((s) => s.type === 'text').map((s) => s.data.text))
const typesOf = (calls) => calls.map((c) => c.params.message.map((s) => s.type).join('+'))

function setup(t, { failure = null, hooks = {}, port = PORT, fetchImpl } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-image-delivery-'))
  const old = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  const calls = []
  const logs = []
  const cfg = normalize({
    enabled: true, dryRun: false, ownerQQ: '100', workspaceDir: dir,
    voice: { enabled: false, autoChance: 0 },
    stickers: { enabled: false, faces: false, autoChance: 0 },
    files: { enabled: true, imageByPath: true },
    security: { ssrfMode: 'strict' },
  })
  setLocalAssetPort(() => port)
  const hub = createHub({
    dsh: {}, getConfig: () => cfg, hooks, fetchImpl,
    log: Object.fromEntries(['info', 'warn', 'debug', 'error'].map((k) => [k, (...v) => logs.push(v.join(' '))])),
    onebot: { async call(action, params) {
      calls.push({ action, params })
      if (failure && params.message.some((s) => s.type === 'image')) throw typeof failure === 'function' ? failure() : failure
      return { message_id: calls.length }
    } },
    stickers: { match() { return null }, segmentFor() { return null }, pickForReply() { return null } },
  })
  t.after(() => {
    hub.dispose()
    setLocalAssetPort(null)
    if (old === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = old
    rmSync(dir, { recursive: true, force: true })
  })
  const chat = () => hub.chatLogOf(dayKey()).map((row) => row.text)
  return { hub, calls, logs, chat }
}

const gifResponse = (body = GIF, status = 200, headers = { 'content-type': 'image/gif' }) => new Response(body, { status, headers })
const refused = () => new OneBotError('send_group_msg', { status: 'failed', retcode: 100, message: '明确拒绝' })
const timeout = () => new OneBotError('send_group_msg', { message: '超时' }, { uncertain: true })

describe('图片发送失败时的文字与流水', { concurrency: 1 }, () => {
  test('本机表情 GIF 拉得到就按图发出去，流水只记 [image]', async (t) => {
    const fetched = []
    const s = setup(t, { fetchImpl: async (url, opts) => { fetched.push({ url: String(url), redirect: opts.redirect }); return gifResponse() } })
    const url = stickerUrl('s')
    const result = await s.hub.deliver('group:9', `![表情](${url})`, { own: true })
    assert.deepEqual(typesOf(s.calls), ['image'])
    assert.equal(Buffer.from(s.calls[0].params.message[0].data.file.slice('base64://'.length), 'base64').subarray(0, 6).toString(), 'GIF89a')
    assert.deepEqual(fetched, [{ url, redirect: 'manual' }])
    assert.equal(result.failed, 0)
    assert.deepEqual(s.chat(), ['[image]'])
    assert.ok(!s.logs.some((line) => line.includes('图片发不出去')))
  })

  test('表情地址被拒时补一句说明，不把内网地址写进消息或流水', async (t) => {
    const s = setup(t)
    const url = stickerUrl('s', HASH12, 1)
    const result = await s.hub.deliver('group:9', `![表情](${url})`, { own: true })
    assert.deepEqual(textsOf(s.calls), ['图没发出去'])
    assert.equal(typesOf(s.calls)[0], 'text')
    assert.equal(result.failed, 0)
    assert.deepEqual(s.chat(), ['图没发出去'])
    assert.ok(s.logs.some((line) => line.includes('不允许访问内网地址')))
    const blob = JSON.stringify(s.calls) + s.chat().join('\n')
    assert.ok(!blob.includes('127.0.0.1'))
    assert.ok(!blob.includes('nekowhale'))
    assert.ok(!blob.includes('不允许访问'))
  })

  test('端口对上但资源 404：只补一次「表情没发出去」', async (t) => {
    let fetches = 0
    const s = setup(t, { fetchImpl: async () => { fetches++; return gifResponse(Buffer.from('nope'), 404, { 'content-type': 'text/plain' }) } })
    const result = await s.hub.deliver('group:9', `![甲](${stickerUrl('s')})\n![乙](${stickerUrl('r', HASH16)})`, { own: true })
    assert.equal(fetches, 2)
    assert.deepEqual(textsOf(s.calls), ['表情没发出去'])
    assert.equal(s.calls.length, 1)
    assert.equal(result.failed, 0)
    assert.deepEqual(s.chat(), ['表情没发出去'])
  })

  test('图和文字混在一起：图失败也不丢掉前后的字，且不额外补一句', async (t) => {
    const s = setup(t)
    const url = 'http://10.1.2.3/secret.png'
    const result = await s.hub.deliver('group:9', `前面这句话\n![图](${url})\n后面这句话`, { own: true })
    assert.deepEqual(textsOf(s.calls), ['前面这句话', '后面这句话'])
    assert.ok(typesOf(s.calls).every((type) => type === 'text'))
    assert.equal(result.failed, 0)
    assert.deepEqual(s.chat(), ['前面这句话 后面这句话'])
    assert.ok(!s.chat().join('\n').includes('[image]'))
    assert.ok(!JSON.stringify(s.calls).includes('10.1.2.3'))
  })

  test('图发出去了就不补说明，文字也只发一次', async (t) => {
    const s = setup(t, { fetchImpl: async () => gifResponse() })
    await s.hub.deliver('group:9', `给你\n![表情](${stickerUrl('s')})`, { own: true })
    assert.deepEqual(typesOf(s.calls), ['text', 'image'])
    assert.deepEqual(textsOf(s.calls), ['给你'])
    assert.deepEqual(s.chat(), ['给你 [image]'])
  })

  test('网关明确拒绝这张图：不记成已发送，全是图时改发一句说明', async (t) => {
    const s = setup(t, { failure: refused, fetchImpl: async () => gifResponse() })
    const result = await s.hub.deliver('group:9', `![表情](${stickerUrl('r', HASH16)})`, { own: true })
    assert.deepEqual(typesOf(s.calls), ['image', 'text'])
    assert.deepEqual(textsOf(s.calls), ['表情没发出去'])
    assert.equal(result.failed, 0)
    assert.deepEqual(s.chat(), ['表情没发出去'])
  })

  test('网关拒绝图片时，已经发出的文字不重发', async (t) => {
    const s = setup(t, { failure: refused, fetchImpl: async () => gifResponse() })
    const result = await s.hub.deliver('group:9', `先说一句\n![表情](${stickerUrl('s')})`, { own: true })
    assert.deepEqual(typesOf(s.calls), ['text', 'image'])
    assert.deepEqual(textsOf(s.calls), ['先说一句'])
    assert.equal(result.failed, 0)
    assert.deepEqual(s.chat(), ['先说一句'])
  })

  test('网关超时：图可能已经发出，不再补文字，流水也不写成已发送', async (t) => {
    const s = setup(t, { failure: timeout, fetchImpl: async () => gifResponse() })
    const result = await s.hub.deliver('group:9', `![表情](${stickerUrl('s')})`, { own: true })
    assert.deepEqual(typesOf(s.calls), ['image'])
    assert.equal(result.failed, 1)
    assert.equal(result.errors[0], '图片可能已经发出去了')
    assert.ok(!String(result.errors[0]).includes('127.0.0.1'))
    assert.deepEqual(s.chat(), [])
  })

  test('跳转一律不跟，即使目标仍是表情路径', async (t) => {
    const fetched = []
    const s = setup(t, { fetchImpl: async (url) => {
      fetched.push(String(url))
      return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } })
    } })
    await s.hub.deliver('group:9', `![表情](${stickerUrl('s')})`, { own: true })
    assert.deepEqual(fetched, [stickerUrl('s')])
    assert.deepEqual(textsOf(s.calls), ['表情没发出去'])
    assert.ok(!JSON.stringify(s.calls).includes('169.254'))
  })

  test('响应不是 GIF 就不发给网关', async (t) => {
    const s = setup(t, { fetchImpl: async () => gifResponse(Buffer.from('{"kind":"balance"}'), 200, { 'content-type': 'application/json' }) })
    await s.hub.deliver('group:9', `![表情](${stickerUrl('s')})`, { own: true })
    assert.deepEqual(typesOf(s.calls), ['text'])
    assert.deepEqual(textsOf(s.calls), ['表情没发出去'])
  })

  test('普通文字回复不会多出一句说明', async (t) => {
    const s = setup(t)
    const result = await s.hub.deliver('group:9', '你好呀', { own: true })
    assert.deepEqual(textsOf(s.calls), ['你好呀'])
    assert.equal(result.failed, 0)
    assert.deepEqual(s.chat(), ['你好呀'])
  })

  test('扩展钩子仍能改写、拦下，内部简报不会跟着失败说明发出去', async (t) => {
    const seen = []
    const blocked = setup(t, { hooks: {
      reply: () => { seen.push('reply'); return null },
      items: (items) => { seen.push('items'); return items },
      send: (message) => { seen.push('send'); return message },
    } })
    await blocked.hub.deliver('group:9', `![表情](${stickerUrl('s')})`, { own: true })
    assert.deepEqual(seen, ['reply'])
    assert.equal(blocked.calls.length, 0)

    const secret = '内部口令-不要外泄-9f3a'
    const passed = []
    const s = setup(t, { hooks: {
      reply: (text) => { passed.push(['reply', text.includes(secret)]); return text },
      items: (items) => { passed.push(['items', items.map((i) => i.kind).join(',')]); return items },
      send: (message) => { passed.push(['send', message.map((seg) => seg.type).join(',')]); return message },
    } })
    await s.hub.deliver('group:9', `【系统提醒，不是主人说的话】${secret}\n![表情](${stickerUrl('s', HASH12, 9)})`, { own: true })
    assert.deepEqual(textsOf(s.calls), ['图没发出去'])
    assert.ok(passed.some((row) => row[0] === 'reply'))
    assert.ok(passed.some((row) => row[0] === 'items'))
    assert.ok(passed.some((row) => row[0] === 'send'))
    const blob = JSON.stringify(s.calls) + s.chat().join('\n')
    assert.ok(!blob.includes(secret))
    assert.ok(!blob.includes('127.0.0.1'))
  })

  test('items 钩子留下的文字在图片失败后仍然发送', async (t) => {
    const s = setup(t, { hooks: { items: (items) => [...items, { kind: 'text', value: '钩子留下的话' }] } })
    await s.hub.deliver('group:9', `![表情](${stickerUrl('s', HASH12, 9)})`, { own: true })
    assert.deepEqual(textsOf(s.calls), ['钩子留下的话'])
    assert.deepEqual(s.chat(), ['钩子留下的话'])
  })
})

describe('本机表情路径边界', { concurrency: 1 }, () => {
  test('只有当前端口上的 s/r GIF 算表情资源', () => {
    setLocalAssetPort(() => PORT)
    try {
      assert.equal(localAssetUrl(stickerUrl('s')), stickerUrl('s'))
      assert.equal(localAssetUrl(stickerUrl('r', HASH16)), stickerUrl('r', HASH16))
      for (const url of [
        stickerUrl('s', HASH12, 80),
        stickerUrl('s', '0123456789a'), // 11
        stickerUrl('s', HASH16 + '0'), // 17
        stickerUrl('s', '0123456789AB'),
        `http://127.0.0.1:${PORT}/x-nekowhale-stickers/pet/balance.json`,
        `http://127.0.0.1:${PORT}/x-nekowhale-stickers/s/${HASH12}.gif/../../pet/balance.json`,
        `http://127.0.0.1:${PORT}/x-nekowhale-stickers/s/../pet/balance.json`,
        `http://127.0.0.1:${PORT}/x-nekowhale-stickers-evil/s/${HASH12}.gif`,
        `http://127.0.0.1:${PORT}/x-nekowhale-stickers/s/${HASH12}.gif?x=1`,
        `http://evil@127.0.0.1:${PORT}/x-nekowhale-stickers/s/${HASH12}.gif`,
        `http://localhost:${PORT}/x-nekowhale-stickers/s/${HASH12}.gif`,
        `http://[::1]:${PORT}/x-nekowhale-stickers/s/${HASH12}.gif`,
        `https://127.0.0.1:${PORT}/x-nekowhale-stickers/s/${HASH12}.gif`,
        `http://127.0.0.1:${PORT}/x-nekowhale-stickers/s/%2e%2e/${HASH12}.gif`,
        `http://10.0.0.5/x-nekowhale-stickers/s/${HASH12}.gif`,
        `http://169.254.169.254/x-nekowhale-stickers/s/${HASH12}.gif`,
        `http://192.168.0.2/x.png`,
      ]) assert.equal(localAssetUrl(url), '', url)
    } finally {
      setLocalAssetPort(null)
    }
  })

  test('端口没注入时，同样的表情地址也不放行', () => {
    setLocalAssetPort(null)
    assert.equal(localAssetUrl(stickerUrl('s')), '')
    assert.equal(currentPort(), 0)
  })

  test('公网 SSRF 检查不因表情例外而放行内网地址', async () => {
    setLocalAssetPort(() => PORT)
    try {
      await assert.rejects(() => assertPublicUrl(stickerUrl('s')), /内网|本机/)
      await assert.rejects(() => assertPublicUrl('http://10.0.0.5/a.png'), /内网/)
      await assert.rejects(() => assertPublicUrl('http://169.254.169.254/latest/meta-data/'), /内网/)
      await assert.rejects(() => fetchImage(stickerUrl('s'), { fetchImpl: async () => { throw new Error('不该发出去') } }), /内网|本机/)
    } finally {
      setLocalAssetPort(null)
    }
  })

  test('表情拉取不跟随重定向，也不接受非 GIF', async () => {
    setLocalAssetPort(() => PORT)
    const calls = []
    try {
      await assert.rejects(() => fetchLocalAsset(stickerUrl('s'), {
        fetchImpl: async (url) => { calls.push(String(url)); return new Response(null, { status: 302, headers: { location: stickerUrl('r', HASH16) } }) },
      }), /跳转/)
      assert.deepEqual(calls, [stickerUrl('s')])
      await assert.rejects(() => fetchLocalAsset(stickerUrl('s'), {
        fetchImpl: async () => gifResponse(Buffer.from('not-a-gif'), 200, { 'content-type': 'image/gif' }),
      }), /GIF/)
      await assert.rejects(() => fetchLocalAsset(`http://127.0.0.1:${PORT}/x-nekowhale-stickers/pet/balance.json`), /不是本机表情资源/)
    } finally {
      setLocalAssetPort(null)
    }
  })

  test('宿主把网页端口交给表情检查', () => {
    const host = readFileSync(new URL('../src/host.js', import.meta.url), 'utf8')
    assert.ok(host.includes('setLocalAssetPort(() => webPortOf())'))
  })
})

function currentPort() {
  return localAssetUrl(stickerUrl('s')) ? PORT : 0
}
