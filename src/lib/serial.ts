/**
 * Execucao em serie por chave: tarefas com a MESMA chave correm uma a seguir a outra (nunca em simultaneo, pela ordem
 * em que foram pedidas); chaves diferentes correm em paralelo. Uma tarefa que falha nao bloqueia as seguintes.
 * `onIdle` corre uma so vez quando a ultima tarefa pendente dessa chave termina.
 * Usado no Quadro: dois arrastos rapidos do mesmo cartao nao podem disparar PATCH concorrentes.
 */
export function keyedSerial() {
  const chains = new Map<string, Promise<unknown>>()
  const pending = new Map<string, number>()
  return {
    run(key: string, task: () => Promise<void>, onIdle?: () => void): Promise<void> {
      pending.set(key, (pending.get(key) ?? 0) + 1)
      const p = (chains.get(key) ?? Promise.resolve()).then(async () => {
        try {
          await task()
        } finally {
          const left = (pending.get(key) ?? 1) - 1
          if (left <= 0) {
            pending.delete(key)
            chains.delete(key)
            onIdle?.()
          } else pending.set(key, left)
        }
      })
      chains.set(key, p.catch(() => undefined)) // a cadeia continua mesmo que esta tarefa falhe
      return p
    },
  }
}
