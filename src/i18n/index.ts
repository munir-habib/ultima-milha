import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import pt from './pt.json'
import en from './en.json'

export type Lang = 'pt' | 'en'

export function initialLang(): Lang {
  try {
    const saved = localStorage.getItem('um.lang')
    if (saved === 'pt' || saved === 'en') return saved
  } catch {
    /* storage indisponivel */
  }
  return navigator.language?.toLowerCase().startsWith('en') ? 'en' : 'pt'
}

i18n.use(initReactI18next).init({
  resources: { pt: { translation: pt }, en: { translation: en } },
  lng: initialLang(),
  fallbackLng: 'pt',
  interpolation: { escapeValue: false },
})

export function setLang(l: Lang) {
  i18n.changeLanguage(l)
  document.documentElement.lang = l
  try {
    localStorage.setItem('um.lang', l)
  } catch {
    /* ignore */
  }
}

export default i18n
