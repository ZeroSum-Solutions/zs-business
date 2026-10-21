// Server-safe half of lib/theme.ts: the root layout inlines this, so it must not import React hooks.
export const THEME_KEY = "zs-theme";

/**
 * Runs inline in <head> before first paint, so a light choice never flashes black. Storage can
 * throw (private mode, blocked site data): the page then stays on the default.
 */
export const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(t==="light"||t==="system")document.documentElement.dataset.theme=t}catch(e){}})()`;
