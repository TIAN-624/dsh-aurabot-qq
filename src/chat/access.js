// 谁能跟她说话、她在每个会话里有多大权限。纯函数。

/** 权限档位：full = DSH 完整工具；social = 只有 QQ 社交工具；chat = 纯聊天，没有工具。 */
export const LEVELS = ['full', 'social', 'chat']

/**
 * @param {object} cfg 插件配置
 * @param {{kind:'private'|'group', userId:string, groupId:string}} msg
 * @returns {{allowed: boolean, reason: string}}
 */
/** 打开后私聊一律不收也不发，主人私聊也不例外。默认关，旧配置行为不变。 */
export const GROUP_ONLY_REASON = '只在群里说话'

export function groupOnlyEnabled(cfg) {
  return cfg?.groupOnly === true
}

export function checkAllowed(cfg, msg) {
  const owner = String(cfg.ownerQQ || '')
  if (msg.kind === 'private') {
    if (groupOnlyEnabled(cfg)) return { allowed: false, reason: GROUP_ONLY_REASON }
    if (msg.userId === owner) return { allowed: true, reason: '主人' }
    const list = (cfg.allow?.private || []).map(String)
    return list.includes(msg.userId)
      ? { allowed: true, reason: '私聊白名单' }
      : { allowed: false, reason: '不在私聊白名单' }
  }
  const groups = (cfg.allow?.groups || []).map(String)
  return groups.includes(msg.groupId)
    ? { allowed: true, reason: '群白名单' }
    : { allowed: false, reason: '不在群白名单' }
}

/** 这个会话用哪一档权限。群聊永远不超过 social。 */
export function levelFor(cfg, chat) {
  const owner = String(cfg.ownerQQ || '')
  if (chat.kind === 'private' && chat.userId === owner) {
    return LEVELS.includes(cfg.ownerLevel) ? cfg.ownerLevel : 'full'
  }
  return 'social'
}

/** 档位 → agent preset id。 */
export function presetFor(level, cfg) {
  if (level !== 'full') return 'aurabot-social'
  return cfg && cfg.longTasks ? 'aurabot-private-long' : 'aurabot-private'
}

const PRIVATE_ACTIONS = new Set([
  'send_private_msg',
  'upload_private_file',
  'send_private_forward_msg',
  'forward_friend_single_msg',
  'friend_poke',
  'set_input_status',
])
const FLEXIBLE_ACTIONS = new Set(['send_msg', 'send_forward_msg', 'send_custom_face', 'send_tuwen_ark', 'send_ark_share'])

function presentId(value) {
  if (value === undefined || value === null) return false
  const text = String(value).trim()
  return text !== '' && text !== '0'
}

/** 这个 OneBot 动作会不会把内容发进私聊。群动作、查询和状态接口返回 false。 */
export function privateSendTarget(action, params = {}) {
  const name = String(action || '').trim().toLowerCase()
  if (!name) return false
  if (PRIVATE_ACTIONS.has(name)) return true
  const body = params && typeof params === 'object' ? params : {}
  const messageType = String(body.message_type || body.messageType || '').trim().toLowerCase()
  const hasGroup = presentId(body.group_id ?? body.groupId)
  const hasUser = presentId(body.user_id ?? body.userId ?? body.target_id ?? body.targetId)
  if (name === 'send_poke') return !hasGroup
  if (!FLEXIBLE_ACTIONS.has(name)) return false
  if (messageType === 'private' || messageType === 'friend') return true
  if (messageType === 'group') return false
  if (hasGroup) return false
  return hasUser
}

/** 群里模式拦私聊发送时返回原因，否则空串。 */
export function privateSendRefusal(cfg, action, params) {
  return groupOnlyEnabled(cfg) && privateSendTarget(action, params) ? GROUP_ONLY_REASON : ''
}

/** 要拦就返回网关错误数据；不拦返回 null。宿主把它变成 OneBot 的明确拒绝，查询接口不受影响。 */
export function rejectPrivateCall(cfg, action, params) {
  const message = privateSendRefusal(cfg, action, params)
  return message ? { action, status: 'failed', retcode: 1403, message } : null
}

/** 私聊消息和私聊戳一戳在群里模式下直接丢掉。好友申请等其它事件不算对话。 */
export function groupOnlyDropsEvent(cfg, event) {
  if (!groupOnlyEnabled(cfg) || !event) return false
  const post = String(event.post_type || '').toLowerCase()
  const type = String(event.message_type || event.messageType || '').toLowerCase()
  if ((post === 'message' || post === 'message_sent') && type === 'private') return true
  return post === 'notice' && event.notice_type === 'notify' && event.sub_type === 'poke' && !presentId(event.group_id)
}

/** 只有主人能做的事（群管、点歌、写文件……）。 */
export function isOwner(cfg, userId) {
  return String(userId || '') !== '' && String(userId) === String(cfg.ownerQQ || '')
}

/** 改资料类操作（改昵称 / 签名 / 头像、改 B 站签名），以及处理好友申请、改白名单的三档权限。 */
export const PROFILE_PERM_LEVELS = ['off', 'owner', 'all']
export const DOUYIN_PERM_KEYS = ['douyinBrowse', 'douyinLike', 'douyinComment', 'douyinShareOwner', 'douyinDm']
/** 小黑盒：浏览（含热榜/搜索）、点赞、评论、发帖（含删自己的帖）。 */
export const HEYBOX_PERM_KEYS = ['heyboxBrowse', 'heyboxLike', 'heyboxComment', 'heyboxPost']
export const PROFILE_PERM_KEYS = ['qqNickname', 'qqSignature', 'qqAvatar', 'biliSign', 'biliAvatar', 'biliComment', 'qqFriendRequest', 'whitelist', ...DOUYIN_PERM_KEYS, ...HEYBOX_PERM_KEYS]
/** 没设过的档位：一律默认仅主人（含抖音浏览/互动/改资料项；用户要放开自己在面板开）。 */
export const profilePermDefault = (key) => 'owner'
export const permOf = (cfg, key) => {
  const p = cfg?.profilePerms?.[key]
  return PROFILE_PERM_LEVELS.includes(p) ? p : profilePermDefault(key)
}

/** 这一档在这个会话里要不要挂工具。owner = 只在主人私聊里挂；all = 哪都挂；off = 不挂。 */
export function profileToolVisible(cfg, key, chat) {
  const p = permOf(cfg, key)
  if (p === 'all') return chat.kind === 'private' || chat.kind === 'group'
  if (p === 'owner') return chat.kind === 'private' && String(chat.userId) === String(cfg.ownerQQ || '')
  return false
}

/** 执行时再查一遍（面板可能刚改过）。allOwner = 这一轮说话的人全是主人。 */
export function profilePermits(cfg, key, chat, allOwner) {
  const p = permOf(cfg, key)
  if (p === 'off') return { ok: false, message: '这个操作在面板里关掉了' }
  if (!profileToolVisible(cfg, key, chat)) return { ok: false, message: '这里不能做这个操作' }
  if (p === 'owner' && !allOwner) return { ok: false, message: '只有主人私聊让我改才行' }
  return { ok: true }
}
