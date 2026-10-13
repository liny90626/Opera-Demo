import { createContext, useContext } from 'react';

export type Lang = 'en' | 'zh';
export const LangContext = createContext<Lang>('en');

/** Inline bilingual helper: t('Housekeeping Board', '房务看板'). Keeps OPERA English as the default. */
export function useT() {
  const lang = useContext(LangContext);
  return (en: string, zh?: string) => (lang === 'zh' && zh ? zh : en);
}

export function useLang() {
  return useContext(LangContext);
}
