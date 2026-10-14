/*
 * Cross-browser shim.
 * Firefox exposes the promise-based `browser` namespace; Chrome (MV3) exposes
 * `chrome`, whose APIs also return promises when called without a callback.
 */
(function (root) {
  'use strict';
  const hasBrowser = typeof root.browser !== 'undefined' && root.browser && root.browser.runtime;
  const ext = hasBrowser ? root.browser : root.chrome;

  root.BB = root.BB || {};
  root.BB.ext = ext;
  root.BB.isFirefox = !!(hasBrowser && typeof root.browser.runtime.getBrowserInfo === 'function');

  /** Send a message to the background script and unwrap `{ok, error}` replies. */
  root.BB.send = async function send(type, payload) {
    const reply = await ext.runtime.sendMessage(Object.assign({ type }, payload || {}));
    if (reply === undefined) throw new Error('No response from background script');
    return reply;
  };
})(globalThis);
