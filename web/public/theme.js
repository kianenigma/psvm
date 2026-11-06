// Applies the saved theme ('light' or 'dark'; none means follow the system) before the page paints.
try {
  const theme = localStorage.getItem('psvm.theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch {
  // Storage blocked: follow the system.
}
