/*
 * API key prompt. Binds a form containing:
 *   .key-input  .key-toggle  .key-save  .key-skip  .key-msg  .key-docs
 * The key is sent to the background, verified against the API and stored there.
 */
(function (root) {
  'use strict';
  const BB = root.BB;

  BB.bindKeyForm = function bindKeyForm(form, opts) {
    const o = opts || {};
    const { send, ui } = BB;
    const input = form.querySelector('.key-input');
    const toggle = form.querySelector('.key-toggle');
    const save = form.querySelector('.key-save');
    const skip = form.querySelector('.key-skip');
    const msg = form.querySelector('.key-msg');
    const docs = form.querySelector('.key-docs');

    if (docs && o.docsUrl) docs.href = o.docsUrl;

    if (toggle) {
      toggle.addEventListener('click', () => {
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        toggle.textContent = show ? 'Hide' : 'Show';
        toggle.setAttribute('aria-pressed', String(show));
      });
    }

    function setMessage(kind, text) {
      ui.clear(msg);
      if (text) msg.append(ui.notice(kind, text));
    }

    async function submit(skipVerify) {
      const key = input.value.trim();
      if (!key) {
        setMessage('error', 'Enter your API key.');
        input.focus();
        return;
      }
      save.disabled = true;
      if (skip) skip.hidden = true;
      ui.clear(msg).append(ui.spinner(skipVerify ? 'Saving…' : 'Verifying key with the API…'));
      try {
        const res = await send('bb:setApiKey', { key, skipVerify: !!skipVerify });
        if (res.ok) {
          input.value = '';
          setMessage('ok', skipVerify ? 'Key saved (not verified).' : 'Key verified and saved.');
          if (o.onSaved) o.onSaved();
        } else {
          setMessage(res.canSkip ? 'warn' : 'error', res.error || 'The key could not be saved.');
          if (res.canSkip && skip) skip.hidden = false;
        }
      } catch (err) {
        setMessage('error', err.message);
      } finally {
        save.disabled = false;
      }
    }

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      submit(false);
    });
    if (skip) skip.addEventListener('click', () => submit(true));
  };
})(globalThis);
