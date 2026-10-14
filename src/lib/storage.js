/* Settings, API key and session-scoped state. */
(function (root) {
  'use strict';
  const BB = root.BB;
  const { ext, config } = BB;
  const local = ext.storage.local;
  // storage.session survives service-worker restarts but not browser restarts.
  const session = ext.storage.session || null;
  const memory = new Map();

  async function getSettings() {
    const { settings } = await local.get('settings');
    return Object.assign({}, config.DEFAULT_SETTINGS, settings || {});
  }

  async function saveSettings(patch) {
    const next = Object.assign({}, await getSettings(), patch || {});
    await local.set({ settings: next });
    return next;
  }

  async function getApiKey() {
    const { apiKey } = await local.get('apiKey');
    return typeof apiKey === 'string' ? apiKey : '';
  }

  async function setApiKey(key, status) {
    await local.set({ apiKey: key, keyStatus: Object.assign({ state: 'ok', at: Date.now() }, status || {}) });
  }

  async function clearApiKey() {
    await local.remove(['apiKey', 'keyStatus']);
  }

  async function getKeyStatus() {
    const { keyStatus } = await local.get('keyStatus');
    return keyStatus || null;
  }

  async function setKeyStatus(state, message) {
    await local.set({ keyStatus: { state, message: message || '', at: Date.now() } });
  }

  const sessionStore = {
    async get(key) {
      if (session) return (await session.get(key))[key];
      return memory.get(key);
    },
    async set(key, value) {
      if (session) return session.set({ [key]: value });
      memory.set(key, value);
    },
    async remove(key) {
      if (session) return session.remove(key);
      memory.delete(key);
    },
  };

  async function getHistory() {
    const { mySubmissions } = await local.get('mySubmissions');
    return Array.isArray(mySubmissions) ? mySubmissions : [];
  }

  async function addHistory(entry) {
    const list = await getHistory();
    list.unshift(Object.assign({ at: Date.now() }, entry));
    await local.set({ mySubmissions: list.slice(0, 100) });
  }

  BB.store = { getSettings, saveSettings, getApiKey, setApiKey, clearApiKey, getKeyStatus, setKeyStatus, session: sessionStore, getHistory, addHistory };
})(globalThis);
