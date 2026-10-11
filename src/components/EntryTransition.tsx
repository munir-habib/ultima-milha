import { useEffect, useLayoutEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ENTRY, entryEnvironment, shouldPlayEntry } from '@/lib/entryTransition'

/**
 * Fases: pending (por decidir) -> [leaving: cartao de login desvanece] -> loader (ecra com icones) -> reveal (app aparece,
 * ecra desvanece) -> done. So corre no arranque frio; em navegacao normal a fase e 'done' desde o inicio.
 */
export type EntryPhase = 'pending' | 'leaving' | 'loader' | 'reveal' | 'done'

// Estado de modulo (nao de componente): sobrevive a remontagens e e reposto ao terminar a sessao.
let played = false
let sawLogin = false

export function useEntrySequence(loading: boolean, hasSession: boolean, ready: boolean) {
  const [phase, setPhase] = useState<EntryPhase>('pending')

  useLayoutEffect(() => {
    if (loading) return
    if (!hasSession) {
      // ecra de login (ou sessao terminada): o proximo arranque com sessao e "frio" outra vez
      sawLogin = true
      if (played) {
        played = false
        setPhase('pending')
      }
      return
    }
    if (ready && !played) {
      played = true
      const play = shouldPlayEntry({ ...entryEnvironment(), alreadyPlayed: false })
      setPhase(play ? (sawLogin ? 'leaving' : 'loader') : 'done')
    }
  }, [loading, hasSession, ready])

  useEffect(() => {
    const next: Partial<Record<EntryPhase, [EntryPhase, number]>> = {
      leaving: ['loader', ENTRY.loginFadeMs],
      loader: ['reveal', ENTRY.loaderMs],
      reveal: ['done', Math.max(ENTRY.revealMs, ENTRY.overlayFadeMs)],
    }
    const step = next[phase]
    if (!step) return
    const id = setTimeout(() => setPhase(step[0]), step[1])
    return () => clearTimeout(id)
  }, [phase])

  return {
    phase,
    /** o login foi mostrado neste arranque (login manual) — senao e sessao guardada e nao ha fase 1 */
    fromLogin: sawLogin,
    /** ainda antes de decidir: vai tocar? (mostra logo o ecra de transicao em vez de um spinner) */
    willPlay: !played && shouldPlayEntry({ ...entryEnvironment(), alreadyPlayed: false }),
  }
}

const ICONS = [
  // camiao de entregas
  <>
    <path d="M3 7h11v9H3z" />
    <path d="M14 10h4l3 3v3h-7z" />
    <circle cx="7" cy="17.5" r="1.8" />
    <circle cx="17" cy="17.5" r="1.8" />
  </>,
  // caixa / encomenda
  <>
    <path d="M12 3l8 4v10l-8 4-8-4V7z" />
    <path d="M4 7l8 4 8-4M12 11v10" />
  </>,
  // rota tracejada com dois pontos
  <>
    <circle cx="6" cy="18" r="2" />
    <circle cx="18" cy="6" r="2" />
    <path d="M6 16C6 9 18 15 18 8" strokeDasharray="2.5 3" />
  </>,
  // check num circulo
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M8 12.5l2.7 2.7L16 9.5" />
  </>,
]

/** Ecra de transicao: circulo neumorfico com 4 icones que alternam um de cada vez. */
export function EntryOverlay({ fading }: { fading: boolean }) {
  const { t } = useTranslation()
  return (
    <div
      className={`entry-overlay ${fading ? 'entry-overlay-out' : ''}`}
      style={{
        ['--entry-overlay-ms' as string]: `${ENTRY.overlayFadeMs}ms`,
        ['--entry-step-ms' as string]: `${ENTRY.iconStepMs}ms`,
        ['--entry-cycle-ms' as string]: `${ENTRY.iconStepMs * ENTRY.iconCount}ms`,
      }}
      role="status"
      aria-live="polite"
      data-testid="entry-overlay"
      data-fading={fading}
    >
      <div className="flex flex-col items-center">
        <div className="entry-circle" aria-hidden="true">
          {ICONS.map((paths, i) => (
            <div key={i} className="entry-icon" data-icon={i} style={{ ['--i' as string]: i }}>
              <svg viewBox="0 0 24 24">{paths}</svg>
            </div>
          ))}
        </div>
        {ENTRY.showLabel ? (
          <p className="entry-label">
            {t('transition.preparing')}
            <span aria-hidden="true">
              <span className="entry-dot">.</span>
              <span className="entry-dot">.</span>
              <span className="entry-dot">.</span>
            </span>
          </p>
        ) : (
          <span className="sr-only">{t('transition.preparing')}</span>
        )}
      </div>
    </div>
  )
}
