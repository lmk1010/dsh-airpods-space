/** Fixed spoken commands. An utterance runs a command only when, after trimming punctuation and filler, it is exactly a phrase. */
import type { CommandKind } from './types.ts'

const PHRASES: Readonly<Record<CommandKind, readonly string[]>> = {
  interrupt: ['停', '停一下', '停下', '停止', '别说了', '打断', 'stop'],
  send: ['发送', '发出去', '发吧', 'send'],
  cancel: ['取消', '算了', '不要了', 'cancel'],
  'new-session': ['新会话', '新建会话', '新对话', '开个新会话'],
  clear: ['清空', '清空输入框', 'clear'],
  read: ['读一下', '朗读', '念一下', '读给我听', 'read'],
  undo: ['撤销', '撤回'],
  approve: ['同意', '允许', '可以'],
  deny: ['拒绝', '不允许'],
  'stop-reading': ['别读了', '不用读了'],
}

const lookup = new Map<string, CommandKind>(
  Object.entries(PHRASES).flatMap(([kind, phrases]) => phrases.map(phrase => [phrase, kind as CommandKind] as const)),
)

/**
 * Recognize a whole-utterance command.
 * @param text - final transcript of one turn.
 * @returns the command, or undefined for ordinary speech.
 */
export function parseCommand(text: string): CommandKind | undefined {
  const bare = text.toLowerCase().replace(/[\s\p{P}]/gu, '')
  if (bare.length === 0 || bare.length > 10) return undefined
  // Exact phrase first ("算了" ends in a filler character), then without leading "好/嗯/那就" and trailing particles.
  return lookup.get(bare) ?? lookup.get(bare.replace(/^[好嗯那就行]+/u, '').replace(/[吧啊呀哦嗯了]+$/u, ''))
}

const TRAILING_SEND = /[\s\p{P}]*(?:然后)?(?:发送|发出去|send)[\s\p{P}吧啊了]*$/iu

/**
 * Split a spoken "send" off the end of an utterance ("帮我查一下天气，发送").
 * @param text - final transcript of one turn.
 * @returns the text before the phrase, or undefined when the utterance does not end with one.
 */
export function trailingSend(text: string): string | undefined {
  const match = TRAILING_SEND.exec(text)
  if (!match || match.index === 0) return undefined
  return text.slice(0, match.index).trim()
}

const TRAILING_INSERT = /[\s\p{P}]*(?:插入|插话|插一句|insert)[\s\p{P}吧啊了]*$/iu

/**
 * Split a spoken "insert" off the end of an utterance ("先别改测试，插入").
 * @param text - final transcript of one turn.
 * @returns the text before the phrase, or undefined when the utterance does not end with one.
 */
export function trailingInsert(text: string): string | undefined {
  const match = TRAILING_INSERT.exec(text)
  if (!match || match.index === 0) return undefined
  return text.slice(0, match.index).trim()
}
