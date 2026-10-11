import { describe, expect, it } from 'vitest'
import { keyedSerial } from './serial'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('keyedSerial: arrastos do mesmo cartao em serie', () => {
  it('a mesma chave nunca corre em simultaneo e respeita a ordem (o ultimo pedido e o ultimo a correr)', async () => {
    const s = keyedSerial()
    const log: string[] = []
    let running = 0, maxRunning = 0
    const task = (name: string, ms: number) => async () => {
      running++; maxRunning = Math.max(maxRunning, running)
      log.push('start ' + name); await sleep(ms); log.push('end ' + name); running--
    }
    await Promise.all([s.run('c1', task('A', 30)), s.run('c1', task('B', 1)), s.run('c1', task('C', 10))])
    expect(maxRunning).toBe(1)
    expect(log).toEqual(['start A', 'end A', 'start B', 'end B', 'start C', 'end C'])
  })
  it('chaves diferentes correm em paralelo', async () => {
    const s = keyedSerial()
    let running = 0, maxRunning = 0
    const task = async () => { running++; maxRunning = Math.max(maxRunning, running); await sleep(20); running-- }
    await Promise.all([s.run('c1', task), s.run('c2', task)])
    expect(maxRunning).toBe(2)
  })
  it('onIdle corre uma so vez, depois da ultima tarefa da chave', async () => {
    const s = keyedSerial()
    const events: string[] = []
    const idle = () => events.push('idle')
    const a = s.run('c1', async () => { await sleep(10); events.push('A') }, idle)
    const b = s.run('c1', async () => { await sleep(1); events.push('B') }, idle)
    await Promise.all([a, b])
    expect(events).toEqual(['A', 'B', 'idle'])
    await s.run('c1', async () => { events.push('C') }, idle) // depois de idle, nova cadeia
    expect(events).toEqual(['A', 'B', 'idle', 'C', 'idle'])
  })
  it('uma tarefa que falha nao bloqueia a seguinte (e o erro chega a quem a pediu)', async () => {
    const s = keyedSerial()
    const log: string[] = []
    const bad = s.run('c1', async () => { throw new Error('403') })
    const good = s.run('c1', async () => { log.push('ok') })
    await expect(bad).rejects.toThrow('403')
    await good
    expect(log).toEqual(['ok'])
  })
})
