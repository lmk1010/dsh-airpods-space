#!/usr/bin/env node
// Test double for dsh-airpods-helper: same stdio protocol, scripted talk turn on `press`.
import { createInterface } from 'node:readline'
const emit = (event, fields = {}) => process.stdout.write(`${JSON.stringify({ event, t: Date.now() / 1000, ...fields })}\n`)
emit('hello', { version: 1 })
emit('permissions', { microphone: 'granted', bluetooth: 'granted' })
emit('device', { productId: '0x200F', model: 'airpods-2', name: 'AirPods (2nd generation)', gesture: 'double-tap', left: 99, right: 98, case: 8 })
emit('claim', { state: 'claimed', reason: 'headphones' })
const pcm = Buffer.alloc(3200, 1).toString('base64')
createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line)
  if (command.cmd === 'press') {
    emit('press', { source: command.source })
    emit('voice', { state: 'opening' })
    emit('voice', { state: 'talking', readyMs: 200 })
    for (let i = 0; i < 3; i++) emit('audio', { pcm })
    emit('voice', { state: 'ended', reason: 'remote' })
  }
  if (command.cmd === 'claim') emit('claim', { state: 'lost', to: { app: 'Friday', bundle: 'ai.friday', pid: 1 } })
})
