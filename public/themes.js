// Color themes. Each sets the CSS variables from styles.css; "dark" and "light" are the built-in
// palettes there (no overrides). Order of the vars: bg side panel card hover active line lineStrong
// text muted faint bubble user userText btn btnHover primary primaryText, then accent.
const V = ['bg', 'side', 'panel', 'card', 'hover', 'active', 'line', 'line-strong', 'text', 'muted', 'faint',
  'bubble', 'user', 'user-text', 'btn', 'btn-hover', 'primary', 'primary-text'];
const t = (name, scheme, accent, colors) => ({ name, scheme, accent, vars: colors ? Object.fromEntries(colors.split(' ').map((c, i) => [V[i], c])) : null });

export const THEMES = {
  dark: t('Nimbus Dark', 'dark', '#3b82f6'),
  light: t('Nimbus Light', 'light', '#3b82f6'),
  midnight: t('Midnight', 'dark', '#7c9cff', '#0b1020 #10162b #141b34 #18203d #1c2547 #232d55 #222b4d #2f3a66 #e6e9f5 #8b93b8 #5b6390 #1a2242 #c9d4ff #0b1020 #1f2850 #283264 #c9d4ff #0b1020'),
  nord: t('Nord', 'dark', '#88c0d0', '#2e3440 #3b4252 #3b4252 #434c5e #434c5e #4c566a #434c5e #4c566a #eceff4 #a3abb9 #6b7385 #3b4252 #88c0d0 #2e3440 #434c5e #4c566a #88c0d0 #2e3440'),
  dracula: t('Dracula', 'dark', '#bd93f9', '#22212c #282a36 #2c2e3c #313342 #363848 #3f4256 #383a4c #4b4e66 #f8f8f2 #a4a7c1 #6f7394 #343746 #bd93f9 #22212c #383a4c #44475a #ff79c6 #22212c'),
  solarizedDark: t('Solarized Dark', 'dark', '#268bd2', '#002b36 #073642 #073642 #0a3d4a #0d4553 #11505f #0d4553 #1a5c6b #eee8d5 #93a1a1 #657b83 #0a3d4a #b58900 #002b36 #0d4553 #11505f #2aa198 #002b36'),
  forest: t('Forest', 'dark', '#4ade80', '#0d1410 #121c16 #15211a #18261e #1c2c22 #23362a #1f2f25 #2c4234 #e3efe6 #8fa898 #5e7566 #18261e #a7e3b5 #0d1410 #1f2f25 #283c30 #a7e3b5 #0d1410'),
  rose: t('Rosé', 'dark', '#eb6f92', '#191724 #1f1d2e #232136 #26233a #2a273f #393552 #2a283e #403d58 #e0def4 #908caa #6e6a86 #26233a #ebbcba #191724 #2a273f #393552 #ebbcba #191724'),
  ocean: t('Ocean', 'dark', '#22d3ee', '#07141c #0b1c26 #0e222e #112834 #142e3b #1a3a4a #163442 #22485a #e1f3f8 #86a9b6 #577784 #112834 #9be7f5 #07141c #163442 #1d4153 #9be7f5 #07141c'),
  contrast: t('High Contrast', 'dark', '#ffd400', '#000000 #0a0a0a #111111 #111111 #1e1e1e #2a2a2a #5a5a5a #8a8a8a #ffffff #d0d0d0 #a0a0a0 #1a1a1a #ffffff #000000 #222222 #333333 #ffffff #000000'),
  paper: t('Paper', 'light', '#b0562a', '#fbf7ef #f3ecdf #efe7d8 #fffcf6 #ebe2d1 #e3d8c4 #e4dac8 #d3c6ae #2b2620 #776c5d #a89c88 #f1e9da #2b2620 #fbf7ef #ece3d2 #e3d8c4 #2b2620 #fbf7ef'),
  solarizedLight: t('Solarized Light', 'light', '#1d6fa8', '#fdf6e3 #f5eedb #eee8d5 #fffbef #e9e2cf #e1d9c4 #e4ddc9 #d3cbb5 #073642 #586e75 #93a1a1 #eee8d5 #073642 #fdf6e3 #eee8d5 #e1d9c4 #073642 #fdf6e3'),
  sky: t('Sky', 'light', '#2563eb', '#f7faff #eef4fd #e9f0fb #ffffff #e1eafa #d6e2f7 #dbe5f5 #c4d4ee #0f1b33 #5a6b8a #93a2bd #e8effb #1d4ed8 #ffffff #e6eefb #d6e2f7 #1d4ed8 #ffffff'),
  blossom: t('Blossom', 'light', '#db2777', '#fff8fb #fdeef4 #fbe9f1 #ffffff #f8e0eb #f3d3e2 #f4dbe6 #e9c3d5 #2e1622 #82586c #b896a6 #fbe7f0 #9d174d #ffffff #f8e3ed #f3d3e2 #9d174d #ffffff')
};

// "system" follows the device: one theme for dark mode, one for light.
export function resolveTheme(prefs, systemDark) {
  if (prefs.theme === 'system') return THEMES[systemDark ? (prefs.darkTheme || 'dark') : (prefs.lightTheme || 'light')];
  return THEMES[prefs.theme] || THEMES.dark;
}

export function applyThemeVars(root, theme, accent) {
  root.dataset.theme = theme.scheme;
  for (const k of V) root.style.removeProperty('--' + k);
  if (theme.vars) for (const [k, v] of Object.entries(theme.vars)) root.style.setProperty('--' + k, v);
  root.style.setProperty('--accent', accent || theme.accent);
  return theme.vars?.side || (theme.scheme === 'dark' ? '#0e0e0f' : '#f6f6f7');
}
