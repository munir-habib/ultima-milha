/**
 * "Mostrar mais" por blocos: renderizar milhares de cartoes bloqueava o browser (medido: Lista 9,7 s com 3627 movimentos e
 * 22,8 s com 10 000; a rede e ~1-2 s). So se desenham os primeiros `shown`; os TOTAIS, o "Selecionar todos (N)", a exportacao
 * e a fila continuam a usar a lista COMPLETA — a paginacao e so visual.
 */
export const SHOW_STEP = 100

export function showMoreInfo(total: number, shown: number, step = SHOW_STEP) {
  const visible = Math.min(total, Math.max(0, shown))
  const rest = total - visible
  return { visible, rest, next: Math.min(step, rest) }
}
