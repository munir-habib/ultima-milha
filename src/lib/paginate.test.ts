import { describe, expect, it } from 'vitest'
import { fetchAllPages, type Page } from './paginate'

/** Servidor falso que se comporta como o PostgREST: no maximo `maxRows` linhas por pedido, mesmo que se peca mais. */
const server = (n: number, maxRows = 1000, calls: [number, number][] = [], counts: boolean[] = []) => (from: number, to: number, wantCount: boolean): Promise<Page<number>> => {
  calls.push([from, to]); counts.push(wantCount)
  const end = Math.min(to, from + maxRows - 1, n - 1)
  return Promise.resolve({ data: from > end ? [] : Array.from({ length: end - from + 1 }, (_, i) => from + i), count: wantCount ? n : null, error: null })
}

describe('fetchAllPages: nunca fica em silencio com menos do que o servidor tem', () => {
  it('3000 linhas com o limite de 1000 por pedido: traz as 3000, sem duplicados', async () => {
    const calls: [number, number][] = []
    const r = await fetchAllPages(server(3000, 1000, calls), 10000)
    expect(r.rows).toHaveLength(3000)
    expect(new Set(r.rows).size).toBe(3000)
    expect(r.total).toBe(3000)
    expect(r.truncated).toBe(false)
    expect(calls).toHaveLength(3)
  })
  it('o count exato so se pede no PRIMEIRO pedido (e caro; repeti-lo por pagina estourava o statement_timeout)', async () => {
    const counts: boolean[] = []
    await fetchAllPages(server(3500, 1000, [], counts), 10000)
    expect(counts).toEqual([true, false, false, false])
  })
  it('poucas linhas: um so pedido; zero linhas: vazio', async () => {
    const calls: [number, number][] = []
    expect((await fetchAllPages(server(42, 1000, calls), 10000)).rows).toHaveLength(42)
    expect(calls).toHaveLength(1)
    const empty = await fetchAllPages(server(0), 10000)
    expect(empty.rows).toEqual([]); expect(empty.truncated).toBe(false)
  })
  it('exatamente 1000 e 1001 linhas (fronteira da pagina)', async () => {
    expect((await fetchAllPages(server(1000), 10000)).rows).toHaveLength(1000)
    const r = await fetchAllPages(server(1001), 10000)
    expect(r.rows).toHaveLength(1001); expect(r.truncated).toBe(false)
  })
  it('servidor com limite mais baixo do que a pagina pedida (500): continua pela contagem, nao pelo tamanho da pagina', async () => {
    const r = await fetchAllPages(server(2300, 500), 10000)
    expect(r.rows).toHaveLength(2300); expect(r.truncated).toBe(false)
  })
  it('acima do teto: corta ao teto e DIZ que truncou (com o total real)', async () => {
    const r = await fetchAllPages(server(25000), 10000)
    expect(r.rows).toHaveLength(10000)
    expect(r.total).toBe(25000)
    expect(r.truncated).toBe(true)
  })
  it('exatamente no teto nao e truncagem', async () => {
    const r = await fetchAllPages(server(10000), 10000)
    expect(r.rows).toHaveLength(10000); expect(r.truncated).toBe(false)
  })
  it('um erro do servidor propaga (nao devolve totais parciais como se fossem completos)', async () => {
    let n = 0
    const flaky = (): Promise<Page<number>> => Promise.resolve(++n === 1 ? { data: Array.from({ length: 1000 }, (_, i) => i), count: 2500, error: null } : { data: null, count: null, error: { message: 'boom' } })
    await expect(fetchAllPages(flaky, 10000)).rejects.toThrow('boom')
  })
})

describe('fetchAllPages: linhas repetidas por escritas entre paginas', () => {
  it('uma insercao entre a 1.a e a 2.a pagina repete a linha da fronteira: conta-se UMA vez (com key)', async () => {
    // 2500 linhas; depois da 1.a pagina entra uma linha no INICIO (ordem desc): tudo desliza 1 e o item 999 volta a vir
    let call = 0
    const fake = (from: number, to: number, wantCount: boolean): Promise<Page<{ id: number }>> => {
      call++
      const shift = call > 1 ? 1 : 0
      const total = 2500 + shift
      const ids = Array.from({ length: Math.max(0, Math.min(to, total - 1) - from + 1) }, (_, i) => from + i - shift)
      return Promise.resolve({ data: ids.map((id) => ({ id })), count: wantCount ? 2500 : null, error: null })
    }
    const sem = await fetchAllPages(fake, 10000)
    expect(new Set(sem.rows.map((r) => r.id)).size).toBeLessThan(sem.rows.length) // sem key: repetida (o defeito)
    call = 0
    const com = await fetchAllPages(fake, 10000, 1000, (r) => String(r.id))
    expect(new Set(com.rows.map((r) => r.id)).size).toBe(com.rows.length)         // com key: sem repetidas
  })
})
