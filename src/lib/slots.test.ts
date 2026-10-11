import { describe, expect, it } from 'vitest'
import { slotStay } from './slots'

describe('ocupacao de posto (data_fim exclusivo)', () => {
  it('em curso', () => {
    expect(slotStay({ data_inicio: '2026-09-20', data_fim: null })).toEqual({ kind: 'open', from: '2026-09-20' })
  })
  it('mostra o ULTIMO dia em que esteve: fim exclusivo 20/09 => ate 19/09', () => {
    expect(slotStay({ data_inicio: '2026-09-01', data_fim: '2026-09-20' })).toEqual({ kind: 'range', from: '2026-09-01', to: '2026-09-19' })
  })
  it('troca A -> B no mesmo dia: A termina no dia anterior ao inicio de B (sem sobreposicao)', () => {
    const a = slotStay({ data_inicio: '2026-09-01', data_fim: '2026-09-20' })
    const b = slotStay({ data_inicio: '2026-09-20', data_fim: null })
    expect(a.kind === 'range' && a.to < b.from).toBe(true)
  })
  it('atravessa fim de mes e de ano', () => {
    expect(slotStay({ data_inicio: '2025-12-30', data_fim: '2026-01-01' })).toEqual({ kind: 'range', from: '2025-12-30', to: '2025-12-31' })
  })
  it('atribuida e retirada no mesmo dia: nunca ocupou um dia inteiro', () => {
    expect(slotStay({ data_inicio: '2026-09-20', data_fim: '2026-09-20' })).toEqual({ kind: 'sameDay', from: '2026-09-20' })
  })
})
