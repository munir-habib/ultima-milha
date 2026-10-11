import { describe, expect, it } from 'vitest'
import { SHOW_STEP, showMoreInfo } from './showMore'

describe('showMoreInfo: so se desenha um bloco de cada vez; o resto e contado, nunca perdido', () => {
  it('mais do que o bloco: mostra o bloco e diz quantos restam', () => {
    expect(showMoreInfo(10000, SHOW_STEP)).toEqual({ visible: 100, rest: 9900, next: 100 })
  })
  it('poucos: mostra tudo e nao ha botao (rest = 0)', () => {
    expect(showMoreInfo(41, SHOW_STEP)).toEqual({ visible: 41, rest: 0, next: 0 })
    expect(showMoreInfo(0, SHOW_STEP)).toEqual({ visible: 0, rest: 0, next: 0 })
  })
  it('fronteira exata e ultimo bloco parcial', () => {
    expect(showMoreInfo(100, 100).rest).toBe(0)
    expect(showMoreInfo(101, 100)).toEqual({ visible: 100, rest: 1, next: 1 })
    expect(showMoreInfo(250, 200)).toEqual({ visible: 200, rest: 50, next: 50 })
  })
  it('depois de mostrar mais, visible + rest = total (nada some)', () => {
    for (const shown of [100, 200, 300, 9999, 20000]) {
      const i = showMoreInfo(3627, shown)
      expect(i.visible + i.rest).toBe(3627)
    }
  })
})
