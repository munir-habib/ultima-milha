import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const isConfigured = Boolean(url && anon)

// "Manter sessao iniciada": localStorage (persistente) ou sessionStorage (termina ao fechar o separador)
const KEEP_KEY = 'um.keep'

export function setKeepSession(keep: boolean) {
  try {
    localStorage.setItem(KEEP_KEY, keep ? '1' : '0')
  } catch {
    /* storage indisponivel */
  }
}

function store(): Storage | null {
  try {
    return localStorage.getItem(KEEP_KEY) === '0' ? sessionStorage : localStorage
  } catch {
    return null
  }
}

const authStorage = {
  getItem: (k: string) => store()?.getItem(k) ?? null,
  setItem: (k: string, v: string) => store()?.setItem(k, v),
  removeItem: (k: string) => {
    try {
      localStorage.removeItem(k)
      sessionStorage.removeItem(k)
    } catch {
      /* ignore */
    }
  },
}

export const supabase = createClient(url ?? 'http://localhost:54321', anon ?? 'missing-anon-key', {
  auth: { storage: authStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
})
