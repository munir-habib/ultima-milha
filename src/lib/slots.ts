import { addDays } from './format'

/**
 * Ocupacao de um posto. `data_fim` e EXCLUSIVO: e o dia em que a viatura ja NAO esta no posto
 * (numa troca A -> B no dia D, A.data_fim = D = B.data_inicio). Para o utilizador mostramos o
 * ULTIMO dia em que esteve (inclusivo), que e o que se le naturalmente.
 */
export type SlotStay =
  | { kind: 'open'; from: string }
  | { kind: 'range'; from: string; to: string } // to = ultimo dia em que a viatura esteve no posto
  | { kind: 'sameDay'; from: string } // atribuida e retirada no mesmo dia: nunca ocupou um dia inteiro

export function slotStay(a: { data_inicio: string; data_fim: string | null }): SlotStay {
  if (!a.data_fim) return { kind: 'open', from: a.data_inicio }
  if (a.data_fim <= a.data_inicio) return { kind: 'sameDay', from: a.data_inicio }
  return { kind: 'range', from: a.data_inicio, to: addDays(a.data_fim, -1) }
}
