const SAFE_PREVIEW_ENV = new Set(['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR', 'PORT', 'CI']);

export function secretlessPreviewEnvironment(source = process.env) {
  const env = Object.fromEntries(Object.entries(source).filter(([name]) => SAFE_PREVIEW_ENV.has(name) || /^LC_[A-Z0-9_]+$/.test(name)));
  env.NODE_ENV = 'development';
  env.FRONTLINE_LOCAL_PREVIEW = '1';
  return env;
}
