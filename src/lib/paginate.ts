/**
 * O PostgREST (Supabase) devolve no MAXIMO 1000 linhas por pedido, mesmo com `.limit(3000)`: sem paginar, totais e saldos
 * calculados no cliente ficam errados em silencio a partir das 1001 linhas. Esta funcao pede paginas (`range`) ate ter tudo
 * (segundo a contagem exata do servidor) ou atingir o teto `cap`; `truncated` diz a verdade sobre o que ficou de fora.
 */
export const PAGE_SIZE = 1000

export interface Page<T> {
  data: T[] | null
  count: number | null
  error: { message: string } | null
}

export interface Paged<T> {
  rows: T[]
  /** total no servidor (contagem exata), ou null se o servidor nao a deu */
  total: number | null
  /** true se ha linhas no servidor que NAO estao em `rows` */
  truncated: boolean
}

/**
 * `fetchPage(from, to, wantCount)`: `wantCount` e true SO no primeiro pedido (o `count` exato e caro: refaze-lo em cada
 * pagina multiplicava o custo e, com muitos milhares de linhas, estourava o statement_timeout).
 */
export async function fetchAllPages<T>(
  fetchPage: (from: number, to: number, wantCount: boolean) => PromiseLike<Page<T>>,
  cap: number,
  pageSize = PAGE_SIZE,
  /** identidade da linha: com OFFSET sobre dados vivos uma insercao entre paginas repete a linha da fronteira — e somava-a duas vezes */
  key?: (row: T) => string,
): Promise<Paged<T>> {
  const rows: T[] = []
  const seen = new Set<string>()
  let fetched = 0 // linhas pedidas (o OFFSET conta as do servidor, com repetidas)
  let total: number | null = null
  for (;;) {
    const { data, count, error } = await fetchPage(fetched, fetched + pageSize - 1, total === null)
    if (error) throw new Error(error.message)
    if (total === null && count !== null) total = count
    const got = data ?? []
    fetched += got.length
    for (const r of got) {
      if (key) { const k = key(r); if (seen.has(k)) continue; seen.add(k) }
      rows.push(r)
    }
    if (got.length === 0) break
    if (rows.length >= cap) break
    if (total !== null ? fetched >= total : got.length < pageSize) break
  }
  const kept = rows.length > cap ? rows.slice(0, cap) : rows
  return { rows: kept, total, truncated: total !== null ? total > kept.length : kept.length >= cap }
}
