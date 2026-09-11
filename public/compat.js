// Classic, deliberately ES5: readable fallback even if the module cannot parse.
(function () {
  var ios = /(?:iPhone|iPad|iPod).*OS (\d+)_/.exec(navigator.userAgent);
  var modal = document.getElementById('modal');
  window.ksaUnsupportedBrowser = !!((ios && Number(ios[1]) < 16) ||
    !modal || typeof modal.showModal !== 'function' ||
    typeof window.structuredClone !== 'function' || !window.crypto ||
    !window.crypto.subtle || typeof window.crypto.randomUUID !== 'function' ||
    !window.indexedDB);
  if (window.ksaUnsupportedBrowser) {
    document.getElementById('app').innerHTML = '<main class="login-page"><div class="login-card"><h1>נדרש עדכון לדפדפן</h1><p>כדי לשמור נתונים בבטחה, עדכן את מערכת ההפעלה והדפדפן. באייפון נדרש iOS 16 ומעלה.</p></div></main>';
  }
}());
