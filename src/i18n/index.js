/**
 * WhatyTerm 国际化系统
 * 支持中文、英文、日文
 */

import zhCN from './locales/zh-CN.json';
import en from './locales/en.json';
import ja from './locales/ja.json';

const translations = {
  'zh-CN': zhCN,
  'en': en,
  'ja': ja
};

let currentLanguage = 'zh-CN';
let initialized = false;

// 从 localStorage 加载语言设置
export function initI18n() {
  if (initialized) return currentLanguage;

  try {
    const savedLanguage = localStorage.getItem('app-language');
    if (savedLanguage && translations[savedLanguage]) {
      currentLanguage = savedLanguage;
    }
  } catch (e) {
    console.warn('无法访问 localStorage，使用默认语言');
  }

  initialized = true;
  return currentLanguage;
}

// 自动初始化
if (typeof window !== 'undefined') {
  initI18n();
}

// 设置当前语言
export function setLanguage(lang) {
  if (translations[lang]) {
    currentLanguage = lang;
    try {
      localStorage.setItem('app-language', lang);
    } catch (e) {
      console.warn('无法保存语言设置');
    }
    return true;
  }
  return false;
}

// 获取当前语言
export function getLanguage() {
  return currentLanguage;
}

// 翻译函数
export function t(key, params = {}) {
  try {
    if (!key || typeof key !== 'string') {
      return String(key || '');
    }

    const keys = key.split('.');
    let value = translations[currentLanguage];

    for (const k of keys) {
      if (value && typeof value === 'object') {
        value = value[k];
      } else {
        return key;
      }
    }

    // 替换参数
    if (typeof value === 'string' && Object.keys(params).length > 0) {
      return value.replace(/\{(\w+)\}/g, (match, param) => {
        return params[param] !== undefined ? params[param] : match;
      });
    }

    return value || key;
  } catch (error) {
    console.error('Translation error:', error);
    return String(key || '');
  }
}

// React Hook
import { useState, useEffect } from 'react';

export function useTranslation() {
  const [lang, setLang] = useState(() => {
    try {
      return currentLanguage || 'zh-CN';
    } catch (e) {
      return 'zh-CN';
    }
  });

  const changeLanguage = (newLang) => {
    try {
      if (setLanguage(newLang)) {
        setLang(newLang);
        window.dispatchEvent(new Event('languagechange'));
      }
    } catch (e) {
      console.error('Language change error:', e);
    }
  };

  useEffect(() => {
    const handleLanguageChange = () => {
      try {
        setLang(getLanguage());
      } catch (e) {
        console.error('Language change handler error:', e);
      }
    };

    window.addEventListener('languagechange', handleLanguageChange);
    return () => window.removeEventListener('languagechange', handleLanguageChange);
  }, []);

  return {
    t: t || ((key) => key),
    language: lang || 'zh-CN',
    setLanguage: changeLanguage
  };
}
