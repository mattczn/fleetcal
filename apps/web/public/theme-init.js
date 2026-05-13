// FOUC guard — runs synchronously in <head> before paint to set
// data-theme on <html> from the user's saved preference. Lives as
// a static file (not inlined in the React tree) so React 19 doesn't
// warn about <script> tags inside components.
try {
  var s = JSON.parse(localStorage.getItem('dispatch-ui-settings') || '{}');
  var t = s.theme || 'light';
  var d = t === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : t;
  document.documentElement.setAttribute('data-theme', d);
} catch (e) { /* localStorage blocked — fall back to light */ }
