import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { copy, type CopyKey, type Language, type Localized } from './copy';
const Context = createContext<{
    language: Language;
    setLanguage: (l: Language) => void;
}>({ language: 'zh-CN', setLanguage: () => { } });
export function LanguageProvider({ children }: {
    children: ReactNode;
}) {
    const [language, setLanguage] = useState<Language>(() => { try {
        return localStorage.getItem('sidera.ui.language') === 'en' ? 'en' : 'zh-CN';
    }
    catch {
        return 'zh-CN';
    } });
    useEffect(() => { document.documentElement.lang = language; try {
        localStorage.setItem('sidera.ui.language', language);
    }
    catch { } }, [language]);
    return <Context.Provider value={{ language, setLanguage }}>{children}</Context.Provider>;
}
export function useLanguage() { const ctx = useContext(Context); return { ...ctx, t: (key: CopyKey) => copy[key][ctx.language], text: (value: Localized) => value[ctx.language] }; }
