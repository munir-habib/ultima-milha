import { describe, expect, it } from 'vitest'
import { ENTRY, shouldPlayEntry } from './entryTransition'

describe('transicao de entrada: configuracao', () => {
  it('a fase 2 e CURTA: entre 500 e 1000 ms', () => {
    expect(ENTRY.loaderMs).toBeGreaterThanOrEqual(500)
    expect(ENTRY.loaderMs).toBeLessThanOrEqual(1000)
  })
  it('cada icone fica visivel ~250-300 ms (com 4 icones num ecra de <= 1 s, o limite inferior e 240)', () => {
    expect(ENTRY.iconStepMs).toBeGreaterThanOrEqual(240)
    expect(ENTRY.iconStepMs).toBeLessThanOrEqual(300)
    expect(ENTRY.iconStepMs * ENTRY.iconCount).toBeLessThanOrEqual(1000) // um ciclo completo cabe na fase 2
  })
  it('fase 1 ~120-250 ms e fase 3 ~400 ms', () => {
    expect(ENTRY.loginFadeMs).toBeGreaterThanOrEqual(120)
    expect(ENTRY.loginFadeMs).toBeLessThanOrEqual(250)
    expect(ENTRY.revealMs).toBe(400)
  })
})

describe('shouldPlayEntry: so num arranque frio', () => {
  const base = { reducedMotion: false, webdriver: false, force: false, alreadyPlayed: false }
  it('arranque frio normal: toca', () => expect(shouldPlayEntry(base)).toBe(true))
  it('navegacao dentro da app (ja tocou neste arranque): nunca', () => expect(shouldPlayEntry({ ...base, alreadyPlayed: true })).toBe(false))
  it('reduzir movimento: salta direto, mesmo com force', () => {
    expect(shouldPlayEntry({ ...base, reducedMotion: true })).toBe(false)
    expect(shouldPlayEntry({ ...base, reducedMotion: true, force: true, webdriver: true })).toBe(false)
  })
  it('automatizacao (testes E2E): salta, salvo force', () => {
    expect(shouldPlayEntry({ ...base, webdriver: true })).toBe(false)
    expect(shouldPlayEntry({ ...base, webdriver: true, force: true })).toBe(true)
  })
})
