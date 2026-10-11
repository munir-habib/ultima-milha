import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'
import type { Profile, Role, Theme } from '@/lib/types'
import { setLang, type Lang } from '@/i18n'

interface AuthState {
  session: Session | null
  profile: Profile | null
  roles: Role[]
  operationIds: string[]
  loading: boolean
  /** perfil/papeis/operacoes ja carregados para a sessao atual (evita o falso 'sem perfil' logo a seguir ao login) */
  profileReady: boolean
  /** sessao valida mas sem perfil/empresa (ou desativado) */
  blocked: 'no_profile' | 'deactivated' | null
  refresh: () => Promise<void>
  signOut: () => Promise<void>
  updatePrefs: (p: Partial<Pick<Profile, 'tema' | 'idioma' | 'nome' | 'manter_sessao'>>) => Promise<void>
}

const Ctx = createContext<AuthState | null>(null)

export function applyTheme(t: Theme) {
  document.documentElement.dataset.theme = t
  const meta = document.querySelector('meta[name="theme-color"]')
  meta?.setAttribute('content', t === 'dark' ? '#0a0a0a' : '#f5f5f5')
  try {
    localStorage.setItem('um.theme', t)
  } catch {
    /* ignore */
  }
}

export function initialTheme(): Theme {
  try {
    const s = localStorage.getItem('um.theme')
    if (s === 'light' || s === 'dark') return s
  } catch {
    /* ignore */
  }
  return 'dark'
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [roles, setRoles] = useState<Role[]>([])
  const [operationIds, setOperationIds] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [loadedFor, setLoadedFor] = useState<string | null>(null)

  const load = useCallback(async (s: Session | null) => {
    if (!s) {
      setProfile(null)
      setRoles([])
      setOperationIds([])
      setLoadedFor(null)
      return
    }
    const [p, r, o] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', s.user.id).maybeSingle(),
      supabase.from('user_roles').select('role').eq('user_id', s.user.id),
      supabase.from('user_operations').select('operation_id').eq('user_id', s.user.id),
    ])
    const prof = (p.data as Profile | null) ?? null
    setProfile(prof)
    setRoles(((r.data ?? []) as { role: Role }[]).map((x) => x.role))
    setOperationIds(((o.data ?? []) as { operation_id: string }[]).map((x) => x.operation_id))
    if (prof) {
      applyTheme(prof.tema)
      setLang(prof.idioma)
    }
    setLoadedFor(s.user.id)
  }, [])

  useEffect(() => {
    applyTheme(initialTheme())
    supabase.auth.getSession().then(async ({ data }) => {
      setSession(data.session)
      await load(data.session)
      setLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_evt, s) => {
      setSession(s)
      // adiar: nao chamar o supabase dentro do callback do proprio auth
      setTimeout(() => void load(s), 0)
    })
    return () => sub.subscription.unsubscribe()
  }, [load])

  const profileReady = !!session && loadedFor === session.user.id

  const value = useMemo<AuthState>(
    () => ({
      session,
      profile,
      roles,
      operationIds,
      loading,
      profileReady,
      blocked: !session || !profileReady ? null : !profile ? 'no_profile' : profile.deleted_at ? 'deactivated' : null,
      refresh: () => load(session),
      signOut: async () => {
        await supabase.auth.signOut()
      },
      updatePrefs: async (p) => {
        if (!session) return
        if (p.tema) applyTheme(p.tema)
        if (p.idioma) setLang(p.idioma as Lang)
        setProfile((prev) => (prev ? { ...prev, ...p } : prev))
        await supabase.from('profiles').update(p).eq('id', session.user.id)
      },
    }),
    [session, profile, roles, operationIds, loading, profileReady, load],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAuth() {
  const c = useContext(Ctx)
  if (!c) throw new Error('useAuth fora de AuthProvider')
  return c
}
