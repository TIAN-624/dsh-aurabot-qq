// groupOnly：默认仍允许主人私聊；打开后私聊不收也不发，群聊照旧。测试不连网。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHub } from '../src/chat/hub.js'
import { normalize, mergeFromPanel, saveConfig, loadConfig } from '../src/core/config.js'
import {
  GROUP_ONLY_REASON, checkAllowed, groupOnlyDropsEvent, privateSendTarget, rejectPrivateCall,
} from '../src/chat/access.js'
import { outboundRefusal } from '../src/modules/qq-api/index.js'
import { OneBotError, isDefiniteFailure } from '../src/onebot/client.js'

const OWNER = '10000001'
const OTHER = '20000002'
const GROUP = '1064320198'

function dayKey(at = new Date()) {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
}

function setup(t, { groupOnly = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-group-only-'))
  const old = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  const calls = []
  const logs = []
  const commands = []
  const hooks = { messages: 0, pokes: 0 }
  const cfg = normalize({
    enabled: true, dryRun: false, ownerQQ: OWNER, botQQ: '30000003', workspaceDir: dir, groupOnly,
    allow: { private: [OTHER], groups: [GROUP] },
    voice: { enabled: false, autoChance: 0 },
    stickers: { enabled: false, faces: false, autoChance: 0 },
    files: { enabled: true, imageByPath: true },
    security: { ssrfMode: 'strict' },
    snowluma: { httpToken: 'token-secret', wsToken: 'ws-secret' },
    imageGen: { apiKey: 'image-secret' },
  })
  const hub = createHub({
    dsh: {}, getConfig: () => cfg,
    log: Object.fromEntries(['info', 'warn', 'debug', 'error'].map((k) => [k, (...v) => logs.push(v.join(' '))])),
    onebot: { async call(action, params) { calls.push({ action, params }); return { message_id: calls.length, user_id: cfg.botQQ, nickname: 'bot' } } },
    stickers: { match() { return null }, segmentFor() { return null }, pickForReply() { return null } },
    hooks: {
      message: async () => { hooks.messages++; return false },
      poke: async () => { hooks.pokes++; return false },
    },
    onCommand: async (msg) => { commands.push(msg.text); return '命令结果' },
    isMuted: (chatId) => chatId === `group:${GROUP}`,
  })
  t.after(() => {
    hub.dispose()
    if (old === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = old
    rmSync(dir, { recursive: true, force: true })
  })
  const privateEvent = (userId, text) => ({
    post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: cfg.botQQ,
    user_id: Number(userId), message_id: 1, sender: { user_id: Number(userId), nickname: '某人' },
    message: [{ type: 'text', data: { text } }],
  })
  const groupEvent = (userId, text) => ({
    post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: cfg.botQQ,
    user_id: Number(userId), group_id: Number(GROUP), message_id: 2,
    sender: { user_id: Number(userId), nickname: '某人' },
    message: [{ type: 'text', data: { text } }],
  })
  return { hub, cfg, calls, logs, commands, hooks, dir, privateEvent, groupEvent, chat: () => hub.chatLogOf(dayKey()) }
}

test('默认关闭：主人私聊仍然允许，旧配置不带这个键', () => {
  assert.equal(normalize({}).groupOnly, false)
  assert.equal(normalize({ ownerQQ: OWNER }).groupOnly, false)
  assert.equal(normalize({ groupOnly: 'false' }).groupOnly, false)
  assert.equal(normalize({ groupOnly: 'true' }).groupOnly, true)
  const legacy = { ownerQQ: OWNER, allow: { private: [], groups: [GROUP] } }
  assert.equal(checkAllowed(normalize(legacy), { kind: 'private', userId: OWNER }).allowed, true)
  assert.equal(checkAllowed(normalize(legacy), { kind: 'private', userId: OTHER }).allowed, false)
  assert.equal(checkAllowed(normalize(legacy), { kind: 'group', groupId: GROUP, userId: OWNER }).reason, '群白名单')
})

test('打开后主人和其他人的私聊都不收，群和 ownerQQ 不动', () => {
  const cfg = normalize({ groupOnly: true, ownerQQ: OWNER, allow: { private: [OTHER], groups: [GROUP] } })
  assert.equal(cfg.ownerQQ, OWNER)
  assert.equal(checkAllowed(cfg, { kind: 'private', userId: OWNER }).reason, GROUP_ONLY_REASON)
  assert.equal(checkAllowed(cfg, { kind: 'private', userId: OTHER }).allowed, false)
  assert.equal(checkAllowed(cfg, { kind: 'group', groupId: GROUP, userId: OWNER }).allowed, true)
  assert.equal(checkAllowed(cfg, { kind: 'group', groupId: GROUP, userId: OTHER }).allowed, true)
  assert.equal(groupOnlyDropsEvent(cfg, { post_type: 'message', message_type: 'private' }), true)
  assert.equal(groupOnlyDropsEvent(cfg, { post_type: 'notice', notice_type: 'notify', sub_type: 'poke' }), true)
  assert.equal(groupOnlyDropsEvent(cfg, { post_type: 'notice', notice_type: 'notify', sub_type: 'poke', group_id: GROUP }), false)
  assert.equal(groupOnlyDropsEvent(cfg, { post_type: 'request', request_type: 'friend' }), false)
  assert.equal(groupOnlyDropsEvent(normalize({}), { post_type: 'message', message_type: 'private' }), false)
})

test('保存和合并不会丢掉开关，也不会丢掉密钥', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-group-only-cfg-'))
  const old = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  try {
    const current = normalize({
      groupOnly: true, ownerQQ: OWNER, allow: { groups: [GROUP] },
      snowluma: { httpToken: 'token-secret', wsToken: 'ws-secret' }, imageGen: { apiKey: 'image-secret' },
    })
    const partial = mergeFromPanel(current, { enabled: true, dryRun: false })
    assert.equal(partial.groupOnly, true)
    assert.equal(partial.ownerQQ, OWNER)
    assert.equal(partial.snowluma.httpToken, 'token-secret')
    assert.equal(partial.snowluma.wsToken, 'ws-secret')
    assert.equal(partial.imageGen.apiKey, 'image-secret')
    const turnedOff = mergeFromPanel(partial, { groupOnly: false })
    assert.equal(turnedOff.groupOnly, false)
    assert.equal(turnedOff.snowluma.httpToken, 'token-secret')
    saveConfig(partial)
    assert.equal(loadConfig().groupOnly, true)
    assert.equal(loadConfig().imageGen.apiKey, 'image-secret')
    const file = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
    assert.equal(file.groupOnly, true)
    assert.equal(file.snowluma.httpToken, 'token-secret')
  } finally {
    if (old === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = old
    rmSync(dir, { recursive: true, force: true })
  }
})

test('私聊发送动作认得出别名，群动作和状态查询不拦', () => {
  const cfg = { groupOnly: true }
  for (const [action, params] of [
    ['send_private_msg', { user_id: OWNER }],
    ['Send_Private_Msg', { user_id: Number(OWNER) }],
    ['upload_private_file', { user_id: OWNER }],
    ['send_msg', { message_type: 'private', user_id: OWNER }],
    ['send_msg', { user_id: OWNER }],
    ['send_msg', { messageType: 'friend', userId: OWNER }],
    ['send_poke', { user_id: OWNER }],
    ['friend_poke', { user_id: OWNER, group_id: GROUP }],
    ['send_forward_msg', { user_id: OWNER }],
    ['send_custom_face', { user_id: OWNER }],
    ['set_input_status', { user_id: OWNER }],
  ]) assert.ok(rejectPrivateCall(cfg, action, params), action)
  for (const [action, params] of [
    ['send_group_msg', { group_id: GROUP }],
    ['send_msg', { message_type: 'group', group_id: GROUP, user_id: OWNER }],
    ['send_poke', { group_id: GROUP, user_id: OWNER }],
    ['group_poke', { group_id: GROUP, user_id: OWNER }],
    ['upload_group_file', { group_id: GROUP }],
    ['get_login_info', {}],
    ['get_status', {}],
    ['get_stranger_info', { user_id: OWNER }],
    ['send_like', { user_id: OWNER }],
  ]) assert.equal(rejectPrivateCall(cfg, action, params), null, action)
  assert.equal(rejectPrivateCall({ groupOnly: false }, 'send_private_msg', { user_id: OWNER }), null)
  assert.equal(privateSendTarget('get_group_member_info', { group_id: GROUP, user_id: OWNER }), false)
  const blocked = rejectPrivateCall(cfg, 'send_private_msg', { user_id: OWNER })
  const error = new OneBotError(blocked.action, blocked)
  assert.equal(isDefiniteFailure(error), true)
  assert.match(error.message, /只在群里说话/)
  assert.equal(outboundRefusal({ action: 'friend_poke', params: { user_id: OTHER }, cfg: normalize({ groupOnly: true, allow: { private: [OTHER], groups: [GROUP] } }) }), GROUP_ONLY_REASON)
  assert.equal(outboundRefusal({ action: 'group_poke', params: { group_id: GROUP, user_id: OWNER }, cfg: normalize({ groupOnly: true, allow: { groups: [GROUP] } }) }), '')
})

test('主人私聊、斜杠命令和私聊戳一戳都不进模型，也不发', async (t) => {
  const s = setup(t, { groupOnly: true })
  await s.hub.onMessage(s.privateEvent(OWNER, '/silent'))
  await s.hub.onMessage(s.privateEvent(OTHER, '你好'))
  await s.hub.onPoke({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', self_id: s.cfg.botQQ, sender_id: OWNER, target_id: s.cfg.botQQ })
  assert.equal(s.commands.length, 0)
  assert.equal(s.hooks.messages, 0)
  assert.equal(s.hooks.pokes, 0)
  assert.equal(s.calls.length, 0)
  assert.equal(s.hub.stats().sent, 0)
  assert.deepEqual(s.chat(), [])
  assert.ok(s.logs.some((line) => line.includes(GROUP_ONLY_REASON)))
})

test('群消息和群里的主人命令照常处理', async (t) => {
  const s = setup(t, { groupOnly: true })
  await s.hub.onMessage(s.groupEvent(OWNER, '/silent'))
  assert.deepEqual(s.commands, ['/silent'])
  assert.equal(s.calls.length, 1)
  assert.equal(s.calls[0].action, 'send_group_msg')
  assert.equal(String(s.calls[0].params.group_id), GROUP)
  await s.hub.onMessage(s.groupEvent(OTHER, '大家好'))
  assert.equal(s.hooks.messages, 0)
  assert.ok(s.chat().some((row) => row.text === '大家好' && row.chatId === `group:${GROUP}`))
  assert.ok(!s.logs.some((line) => line.includes('这条私聊不处理')))
})

test('私聊出站全部拦住，群出站照发，热切换不用重建', async (t) => {
  const s = setup(t, { groupOnly: true })
  const sentBefore = s.hub.stats().sent
  const text = await s.hub.sendText(`private:${OWNER}`, '不该出现')
  const delivered = await s.hub.deliver(`private:${OTHER}`, '模块通知')
  const segments = await s.hub.sendSegments(`private:${OWNER}`, [{ type: 'text', data: { text: '手动' } }], '手动')
  await assert.rejects(s.hub.sendFile(`private:${OWNER}`, join(s.dir, 'none.txt')), new RegExp(GROUP_ONLY_REASON))
  await s.hub.sendImage(`private:${OWNER}`, join(s.dir, 'pic.png'))
  assert.equal(text, null)
  assert.equal(segments, null)
  assert.equal(delivered.failed, 1)
  assert.equal(delivered.errors[0], GROUP_ONLY_REASON)
  assert.equal(s.calls.length, 0)
  assert.equal(s.hub.stats().sent, sentBefore)
  assert.ok(!s.chat().some((row) => row.who === 'bot'))
  const group = await s.hub.deliver(`group:${GROUP}`, '群里这句话')
  assert.equal(group.failed, 0)
  assert.equal(s.calls.at(-1).action, 'send_group_msg')
  assert.equal(s.calls.at(-1).params.message.at(-1).data.text, '群里这句话')
  assert.ok(s.chat().some((row) => row.who === 'bot' && row.text === '群里这句话'))
  s.cfg.groupOnly = false
  const again = await s.hub.sendText(`private:${OWNER}`, '现在可以')
  assert.equal(again.message_id !== undefined, true)
  assert.equal(s.calls.at(-1).action, 'send_private_msg')
  s.cfg.groupOnly = true
  const stopped = await s.hub.sendText(`private:${OWNER}`, '又关掉了')
  assert.equal(stopped, null)
  assert.ok(!s.calls.at(-1).params.message.some((seg) => seg.data?.text === '又关掉了'))
})

test('宿主把私聊调用包在 OneBot 出口上，面板自测也不发', () => {
  const host = readFileSync(new URL('../src/host.js', import.meta.url), 'utf8')
  assert.match(host, /rejectPrivateCall\(getConfig\(\), action, params\)/)
  assert.match(host, /groupOnlyDropsEvent\(cfg, ev\)/)
  assert.match(host, /if \(cfg\.groupOnly\) return \{ ok: false, message: GROUP_ONLY_REASON \}/)
  const saved = readFileSync(new URL('../docs/group-only.txt', import.meta.url), 'utf8')
  assert.match(saved, /groupOnly/)
  assert.match(saved, /3102/)
})
