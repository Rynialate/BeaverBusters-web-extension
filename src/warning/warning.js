(function () {
  'use strict';
  const { send } = globalThis.BB;
  const params = new URLSearchParams(location.search);
  const target = params.get('url') || '';
  const $ = (id) => document.getElementById(id);

  let host = '';
  try {
    host = new URL(target).hostname;
  } catch (e) {
    host = '';
  }
  $('host').textContent = host || 'This site';
  $('host2').textContent = host || 'site';
  document.title = 'Scam site blocked: ' + (host || '');

  send('bb:warningInfo', { url: target }).then((res) => {
    const v = res && res.verdict;
    if (!v) return;
    $('verdict').hidden = false;
    $('label').textContent = v.label || 'Known scam';
    for (const r of v.reasons || []) {
      const li = document.createElement('li');
      li.textContent = r;
      $('reasons').append(li);
    }
    for (const f of (v.fields || []).slice(0, 10)) {
      const dt = document.createElement('dt');
      dt.textContent = f.key;
      const dd = document.createElement('dd');
      dd.textContent = f.value;
      $('fields').append(dt, dd);
    }
  }, () => {});

  $('leave').addEventListener('click', () => {
    send('bb:leave', {}).catch(() => history.back());
  });

  $('proceed').addEventListener('click', () => {
    if (!/^https?:/i.test(target)) return;
    send('bb:allowHost', { url: target });
  });
})();
