/** Whole-utterance command phrases; ordinary speech never triggers a command. */
import { expect, it } from 'vitest'
import { parseCommand, trailingInsert, trailingSend } from '../src/commands.ts'

it('recognizes command phrases with punctuation and trailing filler', () => {
  expect(parseCommand('停一下。')).toBe('interrupt')
  expect(parseCommand('发送吧')).toBe('send')
  expect(parseCommand('算了')).toBe('cancel')
  expect(parseCommand('新会话')).toBe('new-session')
  expect(parseCommand('读一下！')).toBe('read')
  expect(parseCommand('Stop')).toBe('interrupt')
  expect(parseCommand('好，发送。')).toBe('send')
  expect(parseCommand('发现。')).toBe('send')
})

it('leaves sentences that merely contain a phrase as ordinary speech', () => {
  expect(parseCommand('帮我把这个发送给张经理')).toBeUndefined()
  expect(parseCommand('停车场在哪里')).toBeUndefined()
  expect(parseCommand('我发现了一个问题')).toBeUndefined()
  expect(parseCommand('')).toBeUndefined()
})

it('splits a spoken "send" off the end of a sentence', () => {
  expect(trailingSend('帮我查一下天气，发送。')).toBe('帮我查一下天气')
  expect(trailingSend('look this up, send')).toBe('look this up')
  expect(trailingSend('发送')).toBeUndefined()
  expect(trailingSend('帮我把这个发送给张经理')).toBeUndefined()
})

it('splits a spoken "insert" off the end of a sentence', () => {
  expect(trailingInsert('先别改测试，插入。')).toBe('先别改测试')
  expect(trailingInsert('插入')).toBeUndefined()
  expect(trailingInsert('帮我插入一行代码')).toBeUndefined()
})
