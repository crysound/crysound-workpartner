/* Synchronous head script: resolve the device preference before the first paint. */
(() => {
  const key = 'zp-interface-style';
  const root = document.documentElement;
  let saved;
  try { saved = localStorage.getItem(key); }
  catch (error) { /* Storage can be unavailable; retain the default appearance. */ }
  root.dataset.zpSkin = saved === 'soft' ? 'soft' : 'default';
  window.zpSkin = {
    get: () => root.dataset.zpSkin,
    set(value) {
      if (value !== 'default' && value !== 'soft') return false;
      try { localStorage.setItem(key, value); }
      catch (error) { return false; /* Do not claim a device preference was saved. */ }
      root.dataset.zpSkin = value;
      window.dispatchEvent(new Event('zp-skin-change'));
      return true;
    },
  };
  window.addEventListener('storage', event => {
    if (event.key !== key && event.key !== null) return;
    root.dataset.zpSkin = event.newValue === 'soft' ? 'soft' : 'default';
    window.dispatchEvent(new Event('zp-skin-change'));
  });
})();
