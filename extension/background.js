import { normalizeSettings, chooseDelayMs, shouldNotify, inspectProduct, nextProduct, canonicalProductUrl } from './core.js';

const NEXT = 'pokemon-next-check';
const WATCHDOG = 'pokemon-check-watchdog';
const LEASE_MS = 120000;
const emptyMonitor = { enabled: false, checking: false, nextCheckAt: null, lastCheckAt: null, lastStatus: null, lastError: '', lastNotificationAt: null };
let currentRun = null;
let generation = 0;
let mutationQueue = Promise.resolve();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function mutate(action) {
  const result = mutationQueue.then(action);
  mutationQueue = result.catch(() => {});
  return result;
}

async function state() {
  const stored = await chrome.storage.local.get(['settings', 'monitor', 'lastProductState', 'lastProductStates', 'productResults', 'log']);
  const settings = normalizeSettings({}, stored.settings);
  const canonical = value => { try { return canonicalProductUrl(value); } catch { return null; } };
  const lastProductStates = {};
  for (const [key, entry] of Object.entries(stored.lastProductStates || {})) {
    const url = canonical(key);
    if (url && (!lastProductStates[url] || key === url)) lastProductStates[url] = { ...entry, url };
  }
  const legacy = stored.lastProductState;
  const oldUrl = canonical(legacy?.url);
  if (oldUrl && !lastProductStates[oldUrl]) lastProductStates[oldUrl] = { ...legacy, url: oldUrl };
  const productResults = {};
  for (const [key, entry] of Object.entries(stored.productResults || {})) {
    const url = canonical(key);
    if (url && (!productResults[url] || key === url)) productResults[url] = entry;
  }
  const legacyUrl = canonical(stored.monitor?.lastProductUrl) || oldUrl || settings.products[0].productUrl;
  if (stored.monitor?.lastCheckAt && !productResults[legacyUrl]) {
    productResults[legacyUrl] = {
      status: stored.monitor.lastStatus, lastCheckAt: stored.monitor.lastCheckAt,
      lastError: stored.monitor.lastError || '', lastNotificationAt: stored.monitor.lastNotificationAt || null,
    };
  }
  const monitor = { ...emptyMonitor, ...stored.monitor };
  if (monitor.nextProductUrl) monitor.nextProductUrl = canonical(monitor.nextProductUrl);
  if (monitor.lastCheckAt) {
    monitor.lastProductUrl = legacyUrl;
    monitor.lastProductTitle ||= settings.products.find(product => product.productUrl === legacyUrl)?.productTitle || '';
  }
  return { ...stored, settings, lastProductStates, productResults, monitor, log: stored.log || [] };
}

async function updateMonitor(patch) {
  return mutate(async () => {
    const { monitor } = await state();
    await chrome.storage.local.set({ monitor: { ...monitor, ...patch } });
  });
}

async function log(message) {
  return mutate(async () => {
    const { log: entries } = await state();
    await chrome.storage.local.set({ log: [{ at: Date.now(), message }, ...entries].slice(0, 40) });
  });
}

async function badge(text, color) {
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
}

export async function getStatus() {
  const { settings, monitor, productResults, log: entries } = await state();
  const next = nextProduct(settings.products, monitor.nextProductUrl);
  return {
    settings: { products: settings.products, minMinutes: settings.minMinutes, maxMinutes: settings.maxMinutes, productUrl: settings.productUrl, productTitle: settings.productTitle, chatId: settings.chatId, tokenConfigured: Boolean(settings.botToken) },
    monitor: { ...monitor, nextProductUrl: next.productUrl, nextProductTitle: next.productTitle }, log: entries,
    productStatuses: settings.products.map(product => ({ ...product, status: null, lastCheckAt: null, lastError: '', lastNotificationAt: null, ...productResults[product.productUrl] })),
  };
}

async function scheduleNext() {
  return mutate(async () => {
    const { monitor, settings } = await state();
    if (!monitor.enabled) return;
    const nextCheckAt = Date.now() + chooseDelayMs(Math.random, settings.minMinutes, settings.maxMinutes);
    await chrome.alarms.create(NEXT, { when: nextCheckAt });
    await chrome.storage.local.set({ monitor: { ...monitor, nextCheckAt } });
  });
}

function sameProduct(url, target) {
  try {
    const current = new URL(url);
    const expected = new URL(target);
    return current.origin === expected.origin && current.pathname.replace(/\/+$/, '') === expected.pathname.replace(/\/+$/, '');
  } catch { return false; }
}

async function telegram(settings, method, body) {
  if (!settings.botToken) throw new Error('Bitte zuerst den Bot-Token speichern.');
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${settings.botToken}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch { throw new Error('Telegram ist nicht erreichbar oder hat nicht rechtzeitig geantwortet.'); }
  let data;
  try { data = await response.json(); } catch { throw new Error('Telegram hat eine ungültige Antwort geliefert.'); }
  if (!response.ok || data.ok !== true) throw new Error(`Telegram-Anfrage fehlgeschlagen (HTTP ${response.status}). Bot-Token und Chat-ID prüfen.`);
  return data.result;
}

async function sendTelegram(settings, text) {
  if (!settings.chatId) throw new Error('Bitte zuerst die Chat-ID speichern.');
  return telegram(settings, 'sendMessage', { chat_id: settings.chatId, text, link_preview_options: { is_disabled: true } });
}

function cancelled(runGeneration) {
  if (generation !== runGeneration) throw new Error('Die laufende Prüfung wurde beendet.');
}

async function productTab(settings, previousTabId, runGeneration) {
  let tab;
  if (previousTabId) {
    try {
      const previous = await chrome.tabs.get(previousTabId);
      if (sameProduct(previous.url, settings.productUrl)) tab = previous;
    } catch { /* The previously used tab may have been closed. */ }
  }
  if (!tab) {
    const tabs = await chrome.tabs.query({ url: 'https://www.pokemoncenter.com/de-de/product/*' });
    tab = tabs.find(candidate => sameProduct(candidate.url, settings.productUrl));
  }
  cancelled(runGeneration);
  let previousOrigin = null;
  if (tab) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => performance.timeOrigin });
      previousOrigin = result;
    } catch { /* A discarded or still-loading tab is also safe to reload. */ }
    cancelled(runGeneration);
    await chrome.tabs.reload(tab.id);
  } else {
    tab = await chrome.tabs.create({ url: settings.productUrl, active: false });
  }
  await updateMonitor({ productTabId: tab.id });
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    cancelled(runGeneration);
    await sleep(700);
    const current = await chrome.tabs.get(tab.id);
    if (!sameProduct(current.url || current.pendingUrl, settings.productUrl)) throw new Error('Der Produkttab wurde auf eine andere Seite umgeleitet oder gewechselt.');
    if (current.status === 'complete') {
      try {
        const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => ({ ready: document.readyState, origin: performance.timeOrigin }) });
        if (result.ready === 'complete' && (previousOrigin === null || result.origin !== previousOrigin)) return tab.id;
      } catch { /* The document can be replaced while the script is being injected. */ }
    }
  }
  throw new Error('Die Produktseite wurde nicht rechtzeitig fertig geladen.');
}

async function inspectTab(tabId, settings, runGeneration) {
  const deadline = Date.now() + 20000;
  let previous = 'unknown';
  let stable = 0;
  let result = { status: 'unknown', reason: 'Die Produktseite konnte nicht ausgelesen werden.' };
  while (Date.now() < deadline) {
    cancelled(runGeneration);
    const [{ result: snapshot }] = await chrome.scripting.executeScript({
      target: { tabId }, func: inspectProduct,
      args: [{ productUrl: settings.productUrl, productTitle: settings.productTitle }],
    });
    result = snapshot;
    stable = result.status === previous ? stable + 1 : 1;
    previous = result.status;
    if (result.status !== 'unknown' && stable >= 3) return result;
    await sleep(1000);
  }
  return { status: 'unknown', reason: result.reason };
}

async function reserveProduct(runGeneration, startedAt) {
  return mutate(async () => {
    cancelled(runGeneration);
    const { settings, monitor } = await state();
    const product = nextProduct(settings.products, monitor.nextProductUrl);
    const index = settings.products.findIndex(item => item.productUrl === product.productUrl);
    const following = settings.products[(index + 1) % settings.products.length];
    cancelled(runGeneration);
    // Advance before navigation so failures and worker restarts cannot starve later products.
    await chrome.storage.local.set({ monitor: {
      ...monitor, checking: true, checkStartedAt: startedAt, lastError: '',
      checkingProductUrl: product.productUrl, checkingProductTitle: product.productTitle,
      nextProductUrl: following.productUrl, nextProductTitle: following.productTitle,
    } });
    return { settings, monitor, product };
  });
}

async function publishProductResult(product, patch) {
  return mutate(async () => {
    const { monitor, productResults } = await state();
    const result = { ...productResults[product.productUrl], ...patch };
    const summary = { lastProductUrl: product.productUrl, lastProductTitle: product.productTitle };
    if (Object.hasOwn(patch, 'status')) summary.lastStatus = patch.status;
    for (const key of ['lastCheckAt', 'lastError', 'lastReason', 'lastNotificationAt']) {
      if (Object.hasOwn(patch, key)) summary[key] = patch[key];
    }
    await chrome.storage.local.set({
      productResults: { ...productResults, [product.productUrl]: result },
      monitor: { ...monitor, ...summary },
    });
  });
}

async function performCheck(runGeneration) {
  cancelled(runGeneration);
  const startedAt = Date.now();
  let settings;
  let product;
  let observedStatus = null;
  try {
    await chrome.storage.session.set({ checkLease: startedAt });
    await chrome.alarms.create(WATCHDOG, { when: startedAt + LEASE_MS });
    const selection = await reserveProduct(runGeneration, startedAt);
    settings = selection.settings;
    product = selection.product;
    const tabId = await productTab(product, selection.monitor.productTabId, runGeneration);
    const result = await inspectTab(tabId, product, runGeneration);
    cancelled(runGeneration);
    observedStatus = result.status;
    await publishProductResult(product, { lastCheckAt: Date.now(), status: result.status, lastReason: result.reason, lastError: '' });
    if (result.status === 'unknown') throw new Error(result.reason);
    const latest = await state();
    if (!latest.settings.products.some(item => item.productUrl === product.productUrl)) throw new Error('Das Produkt wurde während der Prüfung geändert.');
    if (shouldNotify(latest.lastProductStates[product.productUrl], product.productUrl, result.status)) {
      if (!settings.botToken || !settings.chatId) throw new Error('Produkt verfügbar, aber Telegram ist noch nicht eingerichtet. Bitte Bot-Token und Chat-ID speichern.');
      cancelled(runGeneration);
      await sendTelegram(settings, `Pokémon Center: Warenkorb-Button bedienbar!\n${product.productTitle}\n${product.productUrl}`);
      await publishProductResult(product, { lastNotificationAt: Date.now() });
      await log(`${product.productTitle}: Verfügbarkeit per Telegram gemeldet.`);
    }
    // A failed notification never marks availability as handled; retry next time.
    await mutate(async () => {
      const { lastProductStates } = await state();
      await chrome.storage.local.set({ lastProductStates: { ...lastProductStates, [product.productUrl]: { url: product.productUrl, status: result.status } } });
    });
    await badge(result.status === 'available' ? 'JA' : '–', result.status === 'available' ? '#167047' : '#64748b');
    await log(`${product.productTitle}: ${result.status === 'available' ? 'Produkt verfügbar: Warenkorb-Button bedienbar.' : 'Produkt derzeit nicht verfügbar.'}`);
  } catch (error) {
    // Only fixed API errors or our own product diagnostics reach this path, never credentials.
    const message = error.message.split(settings?.botToken || '\u0000').join('[TOKEN]');
    if (product) await publishProductResult(product, { lastCheckAt: Date.now(), status: observedStatus || 'unknown', lastError: message });
    else await updateMonitor({ lastError: message });
    await badge('!', '#b45309');
    await log(product ? `${product.productTitle}: ${message}` : message);
  } finally {
    await chrome.storage.session.remove('checkLease');
    await chrome.alarms.clear(WATCHDOG);
    await updateMonitor({ checking: false, checkingProductUrl: null, checkingProductTitle: null });
    await scheduleNext();
  }
  return getStatus();
}

export async function runCheck() {
  if (currentRun) return currentRun;
  const runGeneration = generation;
  // Assign the promise before the first await: simultaneous alarm/UI calls share it.
  const run = (async () => {
    const { checkLease } = await chrome.storage.session.get('checkLease');
    cancelled(runGeneration);
    if (checkLease && Date.now() - checkLease < LEASE_MS) throw new Error('Eine Prüfung läuft bereits.');
    return performCheck(runGeneration);
  })();
  currentRun = run;
  try { return await run; } finally { if (currentRun === run) currentRun = null; }
}

async function initialize() {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  await mutate(async () => {
    const { settings, monitor, lastProductStates, productResults } = await state();
    const next = nextProduct(settings.products, monitor.nextProductUrl);
    // In-place migration retains credentials, monitoring, and the previous alert state.
    await chrome.storage.local.set({ settings, lastProductStates, productResults,
      monitor: { ...monitor, nextProductUrl: next.productUrl, nextProductTitle: next.productTitle } });
    await chrome.storage.local.remove('lastProductState');
  });
  const { monitor } = await state();
  if (monitor.checking) {
    const { checkLease } = await chrome.storage.session.get('checkLease');
    if (!checkLease || Date.now() - checkLease >= LEASE_MS) {
      await chrome.storage.session.remove('checkLease');
      await updateMonitor({ checking: false, checkingProductUrl: null, checkingProductTitle: null, lastError: 'Eine frühere Prüfung wurde unterbrochen. Beim nächsten Termin wird erneut geprüft.' });
    } else if (!await chrome.alarms.get(WATCHDOG)) {
      await chrome.alarms.create(WATCHDOG, { when: checkLease + LEASE_MS });
    }
  }
  if (monitor.enabled && !await chrome.alarms.get(NEXT)) await scheduleNext();
}

export async function handleMessage(message) {
  const commandGeneration = generation;
  await ready;
  const { settings } = await state();
  switch (message.type) {
    case 'GET_STATUS': return getStatus();
    case 'SAVE_SETTINGS': {
      if (currentRun) throw new Error('Bitte die laufende Prüfung abwarten, bevor du Einstellungen änderst.');
      const next = normalizeSettings(message.payload, settings);
      await mutate(async () => {
        if (currentRun) throw new Error('Bitte die laufende Prüfung abwarten, bevor du Einstellungen änderst.');
        const { monitor, productResults } = await state();
        let following = nextProduct(next.products, monitor.nextProductUrl, settings.products);
        const oldSingle = settings.products.length === 1 ? settings.products[0] : null;
        if (oldSingle && next.products.length > 1 && following.productUrl === oldSingle.productUrl
            && (productResults[oldSingle.productUrl]?.lastCheckAt
              || (monitor.lastCheckAt && monitor.lastProductUrl === oldSingle.productUrl))) {
          const index = next.products.findIndex(product => product.productUrl === oldSingle.productUrl);
          following = next.products[(index + 1) % next.products.length];
        }
        await chrome.storage.local.set({ settings: next,
          monitor: { ...monitor, nextProductUrl: following.productUrl, nextProductTitle: following.productTitle } });
      });
      if (next.minMinutes !== settings.minMinutes || next.maxMinutes !== settings.maxMinutes) await scheduleNext();
      await log('Einstellungen gespeichert.');
      return getStatus();
    }
    case 'START': {
      if (!settings.botToken || !settings.chatId) throw new Error('Bitte zuerst Bot-Token und Chat-ID speichern und Telegram testen.');
      cancelled(commandGeneration);
      await updateMonitor({ enabled: true });
      cancelled(commandGeneration);
      await scheduleNext(); // Recovery alarm is set before any navigation.
      await log(`Überwachung gestartet. Pro Termin ein Produkt; zufälliger Abstand: ${settings.minMinutes}–${settings.maxMinutes} Minuten.`);
      cancelled(commandGeneration);
      return runCheck();
    }
    case 'STOP': {
      generation++;
      await updateMonitor({ enabled: false, nextCheckAt: null });
      await chrome.alarms.clear(NEXT);
      await log('Überwachung angehalten.');
      return getStatus();
    }
    case 'CHECK_NOW': return runCheck();
    case 'TEST_TELEGRAM':
      await sendTelegram(settings, 'Pokémon-Check: Telegram-Verbindung funktioniert.');
      await log('Telegram-Testnachricht gesendet.');
      return { sent: true };
    case 'LIST_CHATS': {
      const updates = await telegram(settings, 'getUpdates', { timeout: 0, allowed_updates: ['message'] });
      const chats = new Map();
      for (const update of updates) {
        const chat = update.message?.chat;
        if (chat) chats.set(String(chat.id), { id: String(chat.id), name: chat.title || chat.first_name || chat.type });
      }
      return [...chats.values()];
    }
    default: throw new Error('Unbekannte Aktion.');
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('options.html')) return false;
  handleMessage(message).then(data => respond({ ok: true, data }), error => respond({ ok: false, error: error.message }));
  return true;
});
chrome.action.onClicked.addListener(() => { void chrome.runtime.openOptionsPage(); });
chrome.alarms.onAlarm.addListener(alarm => {
  void (async () => {
    await ready;
    const { monitor } = await state();
    if (alarm.name === WATCHDOG && !currentRun) {
      await chrome.storage.session.remove('checkLease');
      await updateMonitor({ checking: false, checkingProductUrl: null, checkingProductTitle: null, lastError: 'Die letzte Prüfung wurde unterbrochen. Ein neuer Termin wird geplant.' });
      await scheduleNext();
    } else if (alarm.name === NEXT && monitor.enabled) {
      try { await runCheck(); } catch (error) { await log(error.message); await scheduleNext(); }
    }
  })().catch(error => console.error('Pokémon-Check:', error.message));
});
chrome.runtime.onInstalled.addListener(event => {
  void initialize().then(() => { if (event.reason === 'install') return chrome.runtime.openOptionsPage(); });
});
chrome.runtime.onStartup.addListener(() => { void initialize(); });
const ready = initialize();
