/**
 * Transicao de ENTRADA (login -> app). So num arranque "frio": login manual bem-sucedido, ou abrir a app com sessao
 * guardada. Nunca em navegacao dentro da app ja autenticada. Configuracao e regras puras (testaveis) num so sitio.
 */
export const ENTRY = {
  /** fase 1: o cartao de login encolhe (scale 1 -> .94) e desvanece */
  loginFadeMs: 220,
  /** fase 2: cada icone fica visivel este tempo antes de dar lugar ao seguinte (crossfade + scale .6 -> 1); ciclo = iconStepMs x iconCount, em CSS (compositor) */
  iconStepMs: 240,
  iconCount: 4,
  /** fase 2: duracao total do ecra de transicao — CURTO (500-1000 ms): acontece a cada login */
  loaderMs: 800,
  /** fase 3: a app aparece com fade + subida de 16 px */
  revealMs: 400,
  /** o ecra de transicao desvanece por cima da app enquanto esta aparece */
  overlayFadeMs: 250,
  /** texto "A preparar a tua operacao..." por baixo do circulo (removivel: false) */
  showLabel: true,
} as const

export interface EntryEnv {
  /** prefers-reduced-motion: reduce */
  reducedMotion: boolean
  /** navegador automatizado (Puppeteer/Playwright): os testes E2E nao podem ficar atras de um ecra de 1 s */
  webdriver: boolean
  /** localStorage um.entry = force: obriga a transicao mesmo em automatizacao (so para testar a propria transicao) */
  force: boolean
}

export function entryEnvironment(): EntryEnv {
  const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  const webdriver = typeof navigator !== 'undefined' && navigator.webdriver === true
  let force = false
  try {
    force = localStorage.getItem('um.entry') === 'force'
  } catch {
    /* ignore */
  }
  return { reducedMotion, webdriver, force }
}

/** Toca a transicao? Uma vez por arranque frio; nunca com "reduzir movimento"; nunca em automatizacao (salvo force). */
export function shouldPlayEntry(env: EntryEnv & { alreadyPlayed: boolean }): boolean {
  if (env.alreadyPlayed) return false
  if (env.reducedMotion) return false // acessibilidade: salta direto para a app (nem com force)
  if (env.webdriver && !env.force) return false
  return true
}
