import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useOperationOptions } from '@/lib/queries'
import type { OperationOption } from '@/lib/types'

interface OpState {
  ops: OperationOption[]
  /** 'all' = todas as operacoes visiveis ao utilizador */
  opId: string | 'all'
  setOpId: (id: string | 'all') => void
}

const Ctx = createContext<OpState>({ ops: [], opId: 'all', setOpId: () => {} })
const KEY = 'um.op'

export function OpProvider({ children }: { children: ReactNode }) {
  const { data } = useOperationOptions()
  const ops = useMemo(() => data ?? [], [data])
  const [opId, setOpIdState] = useState<string | 'all'>(() => {
    try {
      return localStorage.getItem(KEY) ?? 'all'
    } catch {
      return 'all'
    }
  })
  // se a operacao guardada ja nao existe/nao e visivel, volta a "todas"
  useEffect(() => {
    if (opId !== 'all' && ops.length > 0 && !ops.some((o) => o.id === opId)) setOpIdState('all')
  }, [ops, opId])

  const setOpId = (id: string | 'all') => {
    setOpIdState(id)
    try {
      localStorage.setItem(KEY, id)
    } catch {
      /* ignore */
    }
  }
  const value = useMemo(() => ({ ops, opId, setOpId }), [ops, opId])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export const useOp = () => useContext(Ctx)
