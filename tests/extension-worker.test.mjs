import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_URL } from '../extension/core.js';

const NEXT = 'pokemon-next-check';
const WATCHDOG = 'pokemon-check-watchdog';
const credentials = {
  productUrl: DEFAULT_URL,
  productTitle: 'Delta-Herrschaft',
  botToken: '123456:private-test-token',
  chatId: '123456',
};
const productA = { productUrl: DEFAULT_URL, productTitle: 'Delta-Herrschaft' };
const productB = { productUrl: `${DEFAULT_URL}-produkt-b`, productTitle: 'Produkt Beta' };
const productC = { productUrl: `${DEFAULT_URL}-produkt-c`, productTitle: 'Produkt Gamma' };
let fixtureId = 0;

function event() {
  const listeners = [];
  return { listeners, addListener: callback => listeners.push(callback) };
}

function storageArea(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async get(keys) {
      if (keys === null || keys === undefined) return structuredClone(data);
      const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const result = {};
      for (const key of list) {
        if (Object.hasOwn(data, key)) result[key] = structuredClone(data[key]);
        else if (keys && !Array.isArray(keys) && typeof keys === 'object') result[key] = structuredClone(keys[key]);
      }
      return result;
    },
    async set(values) { Object.assign(data, structuredClone(values)); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
    async setAccessLevel() {},
  };
}

async function withWorker(initial, run) {
  const previousChrome = globalThis.chrome;
  const previousFetch = globalThis.fetch;
  const previousSetTimeout = globalThis.setTimeout;
  const alarmState = new Map();
  const alarmCalls = [];
  const local = storageArea(initial.local);
  const session = storageArea(initial.session);
  let origin = 1;
  let reloadCount = 0;
  let blockReload = null;
  let inspectionStatus = 'unavailable';
  let inspectionCount = 0;
  const inspectionHistory = [];
  const navigationHistory = [];
  const statusesByUrl = new Map();
  const failedNavigations = new Set();
  const configured = initial.local?.settings?.products || [productA];
  const tabs = new Map(configured.map((product, index) => [index + 1, { id: index + 1, url: product.productUrl, status: 'complete' }]));
  const chrome = {
    storage: { local, session },
    runtime: {
      id: 'local-pokemon-test',
      getURL: path => `chrome-extension://local-pokemon-test/${path}`,
      onMessage: event(), onInstalled: event(), onStartup: event(),
      async openOptionsPage() {},
    },
    action: {
      onClicked: event(),
      async setBadgeBackgroundColor() {}, async setBadgeText() {},
    },
    alarms: {
      onAlarm: event(),
      async get(name) { return alarmState.get(name); },
      async create(name, options) {
        alarmCalls.push({ name, ...options });
        alarmState.set(name, { name, scheduledTime: options.when });
      },
      async clear(name) { return alarmState.delete(name); },
    },
    tabs: {
      async query() { return [...tabs.values()].map(tab => ({ ...tab })); },
      async get(id) {
        if (!tabs.has(id)) throw new Error('Tab wurde geschlossen.');
        return { ...tabs.get(id) };
      },
      async reload(id) {
        reloadCount++;
        origin++;
        const url = tabs.get(id).url;
        navigationHistory.push(url);
        if (failedNavigations.delete(url)) throw new Error('Test: Produktseite nicht erreichbar.');
        if (blockReload) await blockReload;
      },
      async create({ url }) {
        const id = Math.max(0, ...tabs.keys()) + 1;
        const tab = { id, url, status: 'complete' };
        tabs.set(id, tab);
        navigationHistory.push(url);
        origin++;
        return { ...tab };
      },
    },
    scripting: {
      async executeScript({ func, args }) {
        if (args?.[0]?.productUrl) {
          inspectionCount++;
          const url = args[0].productUrl;
          inspectionHistory.push(url);
          const status = statusesByUrl.get(url) || inspectionStatus;
          return [{ result: { status, reason: status === 'available' ? 'Warenkorb bedienbar' : 'Nicht verfügbar' } }];
        }
        if (func.toString().includes('ready:')) return [{ result: { ready: 'complete', origin } }];
        return [{ result: origin }];
      },
    },
  };
  globalThis.chrome = chrome;
  globalThis.fetch = async () => { throw new Error('A worker fixture must never access the network.'); };
  if (initial.fastTimers) {
    globalThis.setTimeout = (callback, ms, ...args) => previousSetTimeout(callback, Math.min(ms, 5), ...args);
  }
  try {
    const worker = await import(`../extension/background.js?fixture=${++fixtureId}`);
    await worker.handleMessage({ type: 'GET_STATUS' });
    await run({
      worker, chrome, local: local.data, session: session.data, alarmState, alarmCalls,
      reloadCount: () => reloadCount,
      setReloadGate: promise => { blockReload = promise; },
      inspectionCount: () => inspectionCount,
      setInspectionStatus: status => { inspectionStatus = status; },
      setProductStatus: (url, status) => statusesByUrl.set(url, status),
      failNextNavigation: url => failedNavigations.add(url),
      navigationHistory,
      inspectionHistory,
      restartWorker: async () => {
        const restarted = await import(`../extension/background.js?fixture=${++fixtureId}`);
        await restarted.handleMessage({ type: 'GET_STATUS' });
        return restarted;
      },
      setFetch: request => { globalThis.fetch = request; },
    });
  } finally {
    globalThis.chrome = previousChrome;
    globalThis.fetch = previousFetch;
    globalThis.setTimeout = previousSetTimeout;
  }
}

async function spinUntil(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.fail('The mocked worker did not reach the expected asynchronous state.');
}

test('Extension worker: Start ohne Telegram-Daten wird abgelehnt', async () => {
  await withWorker({}, async ({ worker, local, alarmState, reloadCount }) => {
    await assert.rejects(worker.handleMessage({ type: 'START' }), /Bot-Token|Chat-ID/);
    assert.notEqual(local.monitor?.enabled, true);
    assert.equal(alarmState.has(NEXT), false);
    assert.equal(reloadCount(), 0);
  });
});

test('Extension worker: Status enthält keinen Token; Speichern mit leerem Feld erhält ihn', async () => {
  await withWorker({ local: { settings: credentials } }, async ({ worker, local }) => {
    const status = await worker.getStatus();
    assert.equal(status.settings.tokenConfigured, true);
    assert.deepEqual(status.settings.products, [productA]);
    assert.equal(status.settings.minMinutes, 15);
    assert.equal(status.settings.maxMinutes, 30);
    assert.equal(Object.hasOwn(status.settings, 'botToken'), false);
    assert.equal(JSON.stringify(status).includes(credentials.botToken), false);
    await worker.handleMessage({ type: 'SAVE_SETTINGS', payload: { ...credentials, botToken: '', chatId: '-100987654' } });
    assert.equal(local.settings.botToken, credentials.botToken);
    assert.equal(local.settings.chatId, '-100987654');
    assert.equal(JSON.stringify(await worker.getStatus()).includes(credentials.botToken), false);
  });
});

test('Extension worker: Neustart stellt fehlenden Termin mit zufälligem Abstand wieder her', async () => {
  const before = Date.now();
  await withWorker({ local: { settings: credentials, monitor: { enabled: true } } }, async ({ worker, alarmState }) => {
    const status = await worker.getStatus();
    const next = alarmState.get(NEXT);
    assert.ok(next.scheduledTime >= before + 900000);
    assert.ok(next.scheduledTime <= Date.now() + 1800000);
    assert.equal(status.monitor.nextCheckAt, next.scheduledTime);
    assert.equal(status.monitor.enabled, true);
  });
});

test('Extension worker: Stop leert den Termin, auch wenn eine Prüfung noch läuft', async () => {
  await withWorker({ local: { settings: credentials, monitor: { enabled: true } } }, async ({ worker, alarmState, alarmCalls, reloadCount, setReloadGate }) => {
    let releaseReload;
    setReloadGate(new Promise(resolve => { releaseReload = resolve; }));
    const pendingCheck = worker.runCheck();
    await spinUntil(() => reloadCount() === 1);
    const stopped = await worker.handleMessage({ type: 'STOP' });
    assert.equal(stopped.monitor.enabled, false);
    assert.equal(stopped.monitor.nextCheckAt, null);
    assert.equal(alarmState.has(NEXT), false);
    const scheduledBeforeFinish = alarmCalls.filter(call => call.name === NEXT).length;
    releaseReload();
    await pendingCheck;
    assert.equal(alarmState.has(NEXT), false);
    assert.equal(alarmState.has(WATCHDOG), false);
    assert.equal(alarmCalls.filter(call => call.name === NEXT).length, scheduledBeforeFinish);
    assert.equal((await worker.getStatus()).monitor.checking, false);
  });
});

test('Extension worker: Veraltete Prüfmarkierung wird beim Neustart bereinigt', async () => {
  await withWorker({
    local: { settings: credentials, monitor: { enabled: true, checking: true } },
    session: { checkLease: Date.now() - 180000 },
  }, async ({ worker, session, alarmState }) => {
    const status = await worker.getStatus();
    assert.equal(status.monitor.checking, false);
    assert.match(status.monitor.lastError, /unterbrochen/);
    assert.equal(session.checkLease, undefined);
    assert.equal(alarmState.has(NEXT), true);
  });
});

test('Extension worker: Watchdog plant nach verlorenem Worker erneut; deaktivierter Monitor bleibt still', async () => {
  await withWorker({
    local: { settings: credentials, monitor: { enabled: true, checking: true } },
    session: { checkLease: Date.now() },
  }, async ({ worker, chrome, local, session, alarmState, reloadCount }) => {
    assert.equal(alarmState.has(WATCHDOG), true);
    alarmState.delete(NEXT);
    chrome.alarms.onAlarm.listeners[0]({ name: WATCHDOG });
    await spinUntil(() => alarmState.has(NEXT) && local.monitor.checking === false);
    assert.equal(session.checkLease, undefined);
    assert.match((await worker.getStatus()).monitor.lastError, /unterbrochen/);
    await worker.handleMessage({ type: 'STOP' });
    chrome.alarms.onAlarm.listeners[0]({ name: NEXT });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reloadCount(), 0);
    assert.equal(alarmState.has(NEXT), false);
  });
});

test('Extension worker: Nur die eigene Einstellungsseite darf Befehle senden', async () => {
  await withWorker({ local: { settings: credentials } }, async ({ chrome }) => {
    const listener = chrome.runtime.onMessage.listeners[0];
    let responded = false;
    assert.equal(listener({ type: 'GET_STATUS' }, {
      id: chrome.runtime.id, url: DEFAULT_URL,
    }, () => { responded = true; }), false);
    assert.equal(responded, false);
    const result = await new Promise(resolve => {
      assert.equal(listener({ type: 'GET_STATUS' }, {
        id: chrome.runtime.id, url: chrome.runtime.getURL('options.html'),
      }, resolve), true);
    });
    assert.equal(result.ok, true);
    assert.equal(result.data.settings.tokenConfigured, true);
    assert.equal(Object.hasOwn(result.data.settings, 'botToken'), false);
  });
});

test('Extension worker: Gleichzeitige Prüfaufrufe teilen bereits vor dem ersten Lease-Await dieselbe Prüfung', async () => {
  await withWorker({ fastTimers: true, local: { settings: credentials } }, async ({ worker, chrome, reloadCount, inspectionCount }) => {
    const originalGet = chrome.storage.session.get;
    let releaseLeaseRead;
    const leaseGate = new Promise(resolve => { releaseLeaseRead = resolve; });
    let leaseReads = 0;
    chrome.storage.session.get = async keys => {
      if (keys === 'checkLease') {
        leaseReads++;
        await leaseGate;
      }
      return originalGet(keys);
    };
    const first = worker.runCheck();
    const second = worker.runCheck();
    await spinUntil(() => leaseReads > 0);
    const readsBeforeRelease = leaseReads;
    releaseLeaseRead();
    const results = await Promise.all([first, second]);
    assert.equal(readsBeforeRelease, 1, 'Ein zweiter Aufruf darf keinen eigenen Lease-Lesevorgang beginnen');
    assert.equal(reloadCount(), 1, 'Der Tab darf nur einmal neu geladen werden');
    assert.equal(inspectionCount(), 3, 'Nur eine Folge von drei stabilen Snapshots darf ausgeführt werden');
    assert.equal(results[0].monitor.lastStatus, 'unavailable');
    assert.deepEqual(results[0], results[1]);
  });
});

test('Extension worker: Stop parallel zur abschließenden Monitor-Speicherung bleibt dauerhaft deaktiviert', async () => {
  await withWorker({ fastTimers: true, local: { settings: credentials, monitor: { enabled: true } } }, async ({ worker, chrome, local, alarmState }) => {
    const originalSet = chrome.storage.local.set;
    let releaseFinalWrite;
    const finalWriteGate = new Promise(resolve => { releaseFinalWrite = resolve; });
    let finalWriteReached = false;
    chrome.storage.local.set = async values => {
      if (!finalWriteReached && values.monitor?.checking === false
          && values.monitor.lastStatus === 'unavailable' && values.monitor.enabled === true) {
        finalWriteReached = true;
        await finalWriteGate;
      }
      return originalSet(values);
    };
    const pendingCheck = worker.runCheck();
    await spinUntil(() => finalWriteReached);
    const pendingStop = worker.handleMessage({ type: 'STOP' });
    // Allow STOP to read the current monitor and enqueue its mutation before
    // the older final write is released. This reproduces the stale-write race.
    await new Promise(resolve => setImmediate(resolve));
    releaseFinalWrite();
    await Promise.all([pendingCheck, pendingStop]);
    const status = await worker.getStatus();
    assert.equal(local.monitor.enabled, false);
    assert.equal(status.monitor.enabled, false);
    assert.equal(status.monitor.checking, false);
    assert.equal(status.monitor.nextCheckAt, null);
    assert.equal(alarmState.has(NEXT), false, 'finally darf nach Stop keinen neuen Alarm hinterlassen');
  });
});

test('Extension worker: Telegram-Fehler wird erneut versucht; bestätigter Versand wird dedupliziert', async () => {
  const previousState = { url: DEFAULT_URL, status: 'unavailable' };
  await withWorker({
    fastTimers: true,
    local: { settings: credentials, lastProductState: previousState },
  }, async ({ worker, local, setInspectionStatus, setFetch }) => {
    setInspectionStatus('available');
    let attempts = 0;
    setFetch(async (url, options) => {
      attempts++;
      assert.equal(url, `https://api.telegram.org/bot${credentials.botToken}/sendMessage`);
      assert.equal(JSON.parse(options.body).chat_id, credentials.chatId);
      return attempts === 1
        ? { ok: false, status: 503, json: async () => ({ ok: false }) }
        : { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: attempts } }) };
    });
    await worker.runCheck();
    assert.equal(attempts, 1);
    assert.deepEqual(local.lastProductStates[DEFAULT_URL], previousState, 'Fehlgeschlagener Versand darf den Bestand nicht als gemeldet speichern');
    let status = await worker.getStatus();
    assert.equal(status.monitor.lastStatus, 'available');
    assert.match(status.monitor.lastError, /503/);
    assert.equal(JSON.stringify(status).includes(credentials.botToken), false);

    await worker.runCheck();
    assert.equal(attempts, 2, 'Nächste Prüfung muss den Telegram-Versand erneut versuchen');
    assert.deepEqual(local.lastProductStates[DEFAULT_URL], { url: DEFAULT_URL, status: 'available' });
    status = await worker.getStatus();
    assert.equal(status.monitor.lastError, '');
    assert.ok(status.monitor.lastNotificationAt);

    await worker.runCheck();
    assert.equal(attempts, 2, 'Gleicher Bestand nach erfolgreichem Versand darf keine weitere Nachricht senden');
    setInspectionStatus('unavailable');
    await worker.runCheck();
    assert.equal(attempts, 2);
    setInspectionStatus('available');
    await worker.runCheck();
    assert.equal(attempts, 3, 'Nach echtem Bestandswechsel muss erneut gemeldet werden');
  });
});

test('Extension worker: Stop während des ersten Lease-Lesevorgangs verhindert Navigation und Versand', async () => {
  await withWorker({ fastTimers: true, local: { settings: credentials, monitor: { enabled: true } } }, async ({ worker, chrome, session, alarmState, reloadCount, inspectionCount, setFetch }) => {
    const originalGet = chrome.storage.session.get;
    let releaseLeaseRead;
    const leaseGate = new Promise(resolve => { releaseLeaseRead = resolve; });
    let leaseReadReached = false;
    let sent = 0;
    setFetch(async () => { sent++; throw new Error('An abgebrochener Check darf nichts senden.'); });
    chrome.storage.session.get = async keys => {
      if (keys === 'checkLease') {
        leaseReadReached = true;
        await leaseGate;
      }
      return originalGet(keys);
    };
    // Attach the rejection handler immediately: cancellation is the expected outcome.
    const pendingCheck = worker.runCheck().then(value => ({ value }), error => ({ error }));
    await spinUntil(() => leaseReadReached);
    await worker.handleMessage({ type: 'STOP' });
    releaseLeaseRead();
    const result = await pendingCheck;
    assert.ok(result.error, 'Ein vor Stop begonnener Aufruf darf nach dem Lease-Await nicht neu starten');
    assert.match(result.error.message, /beendet/);
    assert.equal(reloadCount(), 0);
    assert.equal(inspectionCount(), 0);
    assert.equal(sent, 0);
    assert.equal(session.checkLease, undefined);
    assert.equal(alarmState.has(NEXT), false);
    assert.equal(alarmState.has(WATCHDOG), false);
    const status = await worker.getStatus();
    assert.equal(status.monitor.enabled, false);
    assert.equal(status.monitor.checking, false);
    assert.equal(status.monitor.nextCheckAt, null);
  });
});

test('Extension worker: Einzelprodukt und bisheriger Meldestatus werden ohne erneuten Alarm migriert', async () => {
  await withWorker({
    fastTimers: true,
    local: { settings: credentials, lastProductState: { url: DEFAULT_URL, status: 'available' } },
  }, async ({ worker, local, setInspectionStatus, setFetch }) => {
    const status = await worker.getStatus();
    assert.deepEqual(status.settings.products, [productA]);
    assert.deepEqual(local.lastProductStates[DEFAULT_URL], { url: DEFAULT_URL, status: 'available' });
    assert.equal(local.lastProductState, undefined);
    let sends = 0;
    setFetch(async () => { sends++; throw new Error('Die Migration darf keinen bereits gesendeten Alarm wiederholen.'); });
    setInspectionStatus('available');
    await worker.runCheck();
    assert.equal(sends, 0);
    assert.equal(local.lastProductStates[DEFAULT_URL].status, 'available');
  });
});

test('Extension worker: Migration kanonisiert alte URLs mit abschließendem Slash ohne erneuten Alarm', async t => {
  const oldUrl = `${DEFAULT_URL}/`;
  for (const [name, previous] of [
    ['bisheriger Einzelstatus', { lastProductState: { url: oldUrl, status: 'available' } }],
    ['bereits gespeicherte Status-Map', { lastProductStates: { [oldUrl]: { url: oldUrl, status: 'available' } } }],
  ]) {
    await t.test(name, async () => {
      await withWorker({
        fastTimers: true,
        local: { settings: { ...credentials, productUrl: oldUrl }, ...previous },
      }, async ({ worker, local, setInspectionStatus, setFetch }) => {
        const status = await worker.getStatus();
        assert.equal(status.settings.products[0].productUrl, DEFAULT_URL);
        assert.deepEqual(local.lastProductStates[DEFAULT_URL], { url: DEFAULT_URL, status: 'available' });
        assert.equal(Object.hasOwn(local.lastProductStates, oldUrl), false);
        let sends = 0;
        setFetch(async () => { sends++; throw new Error('URL-Kanonisierung darf einen bestehenden Alarm nicht wiederholen.'); });
        setInspectionStatus('available');
        await worker.runCheck();
        assert.equal(sends, 0);
        assert.equal(local.lastProductStates[DEFAULT_URL].status, 'available');
      });
    });
  }
});

test('Extension worker: Rotation prüft pro Lauf genau ein Produkt und dedupliziert pro URL', async () => {
  await withWorker({
    fastTimers: true,
    local: { settings: { ...credentials, products: [productA, productB] } },
  }, async ({ worker, local, navigationHistory, setProductStatus, setFetch }) => {
    setProductStatus(productA.productUrl, 'available');
    setProductStatus(productB.productUrl, 'available');
    const messages = [];
    setFetch(async (_url, options) => {
      messages.push(JSON.parse(options.body).text);
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: messages.length } }) };
    });
    await worker.runCheck();
    assert.deepEqual(navigationHistory, [productA.productUrl]);
    assert.equal(local.monitor.nextProductUrl, productB.productUrl);
    await worker.runCheck();
    assert.deepEqual(navigationHistory, [productA.productUrl, productB.productUrl]);
    assert.equal(local.monitor.nextProductUrl, productA.productUrl);
    await worker.runCheck();
    assert.deepEqual(navigationHistory, [productA.productUrl, productB.productUrl, productA.productUrl]);
    assert.equal(messages.length, 2, 'A verfügbar / B verfügbar / A verfügbar muss genau zwei Nachrichten senden');
    assert.ok(messages[0].includes(productA.productUrl));
    assert.ok(messages[1].includes(productB.productUrl));
    assert.equal(local.lastProductStates[productA.productUrl].status, 'available');
    assert.equal(local.lastProductStates[productB.productUrl].status, 'available');

    // A's negative signal must not re-arm B's already handled availability.
    setProductStatus(productA.productUrl, 'unavailable');
    await worker.runCheck(); // B stays available.
    await worker.runCheck(); // A becomes unavailable.
    assert.equal(local.lastProductStates[productA.productUrl].status, 'unavailable');
    assert.equal(local.lastProductStates[productB.productUrl].status, 'available');
    await worker.runCheck(); // B still must not be re-notified.
    assert.equal(messages.length, 2);
    setProductStatus(productA.productUrl, 'available');
    await worker.runCheck(); // A is restocked.
    assert.equal(messages.length, 3);
    assert.ok(messages[2].includes(productA.productUrl));
    assert.equal(navigationHistory.length, 7, 'Jeder der sieben Aufrufe darf genau ein Produkt laden');
  });
});

test('Extension worker: Fehlgeschlagene Navigation und Worker-Neustart erhalten den Rotationsfortschritt', async () => {
  await withWorker({
    fastTimers: true,
    local: { settings: { ...credentials, products: [productA, productB, productC] } },
  }, async ({ worker, local, navigationHistory, failNextNavigation, restartWorker }) => {
    failNextNavigation(productA.productUrl);
    await worker.runCheck();
    assert.deepEqual(navigationHistory, [productA.productUrl]);
    assert.equal(local.monitor.nextProductUrl, productB.productUrl);
    assert.equal(local.lastProductStates?.[productA.productUrl], undefined);
    assert.match(local.monitor.lastError, /nicht erreichbar/);
    const restarted = await restartWorker();
    await restarted.runCheck();
    assert.deepEqual(navigationHistory, [productA.productUrl, productB.productUrl]);
    assert.equal(local.monitor.nextProductUrl, productC.productUrl);
    await restarted.runCheck();
    assert.deepEqual(navigationHistory, [productA.productUrl, productB.productUrl, productC.productUrl]);
    assert.equal(local.monitor.nextProductUrl, productA.productUrl);
    assert.equal(local.lastProductStates[productB.productUrl].status, 'unavailable');
    assert.equal(local.lastProductStates[productC.productUrl].status, 'unavailable');
  });
});

test('Extension worker: Umsortieren erhält das nächste Produkt; Entfernen hinterlässt keinen ungültigen Zeiger', async () => {
  await withWorker({
    fastTimers: true,
    local: {
      settings: { ...credentials, products: [productA, productB, productC] },
      monitor: { nextProductUrl: productB.productUrl },
    },
  }, async ({ worker, local, navigationHistory }) => {
    await worker.handleMessage({ type: 'SAVE_SETTINGS', payload: { products: [productC, productB, productA] } });
    assert.equal(local.monitor.nextProductUrl, productB.productUrl);
    await worker.runCheck();
    assert.deepEqual(navigationHistory, [productB.productUrl]);
    assert.equal(local.monitor.nextProductUrl, productA.productUrl);
    await worker.handleMessage({ type: 'SAVE_SETTINGS', payload: { products: [productC, productB] } });
    assert.ok([productC.productUrl, productB.productUrl].includes(local.monitor.nextProductUrl));
    await worker.runCheck();
    await worker.runCheck();
    assert.equal(navigationHistory.length, 3);
    assert.deepEqual(new Set(navigationHistory.slice(1)), new Set([productC.productUrl, productB.productUrl]));
    assert.ok([productC.productUrl, productB.productUrl].includes(local.monitor.nextProductUrl));
  });
});

test('Extension worker: Speichern neuer Zeitgrenzen ersetzt bei laufender Überwachung sofort den Termin', async () => {
  await withWorker({
    local: { settings: { ...credentials, products: [productA], minMinutes: 15, maxMinutes: 30 }, monitor: { enabled: true } },
  }, async ({ worker, local, alarmState, alarmCalls, reloadCount }) => {
    const previousCalls = alarmCalls.filter(call => call.name === NEXT).length;
    const before = Date.now();
    const status = await worker.handleMessage({ type: 'SAVE_SETTINGS', payload: { minMinutes: 1.25, maxMinutes: 1.25, botToken: '' } });
    const next = alarmState.get(NEXT);
    assert.equal(status.settings.minMinutes, 1.25);
    assert.equal(status.settings.maxMinutes, 1.25);
    assert.ok(next.scheduledTime >= before + 75000);
    assert.ok(next.scheduledTime <= Date.now() + 75000);
    assert.equal(status.monitor.nextCheckAt, next.scheduledTime);
    assert.equal(status.monitor.enabled, true);
    assert.equal(alarmCalls.filter(call => call.name === NEXT).length, previousCalls + 1);
    assert.equal(local.settings.botToken, credentials.botToken);
    assert.equal(reloadCount(), 0, 'Zeiten speichern darf keine unerwartete Produktprüfung auslösen');
  });
});

test('Extension worker: Zweites Produkt setzt einen begonnenen Einzelprodukt-Zyklus sinnvoll fort', async t => {
  await t.test('bereits geprüftes A wird beim Hinzufügen von B nicht erneut vorgezogen', async () => {
    await withWorker({
      fastTimers: true,
      local: {
        settings: { ...credentials, products: [productA] },
        monitor: {
          nextProductUrl: productA.productUrl,
          lastProductUrl: productA.productUrl,
          lastCheckAt: Date.now() - 60000,
          lastStatus: 'unavailable',
        },
        lastProductStates: { [productA.productUrl]: { url: productA.productUrl, status: 'unavailable' } },
      },
    }, async ({ worker, local, navigationHistory }) => {
      const status = await worker.handleMessage({ type: 'SAVE_SETTINGS', payload: { products: [productA, productB] } });
      assert.equal(status.monitor.nextProductUrl, productB.productUrl);
      assert.equal(local.monitor.nextProductUrl, productB.productUrl);
      assert.deepEqual(navigationHistory, [], 'Hinzufügen allein soll noch keine Seite laden');
      await worker.runCheck();
      assert.deepEqual(navigationHistory, [productB.productUrl]);
      assert.equal(local.monitor.nextProductUrl, productA.productUrl);
    });
  });

  await t.test('noch nie geprüftes A bleibt nach dem Hinzufügen von B zuerst an der Reihe', async () => {
    await withWorker({
      fastTimers: true,
      local: {
        settings: { ...credentials, products: [productA] },
        monitor: { nextProductUrl: productA.productUrl, lastCheckAt: null },
      },
    }, async ({ worker, local, navigationHistory }) => {
      const status = await worker.handleMessage({ type: 'SAVE_SETTINGS', payload: { products: [productA, productB] } });
      assert.equal(status.monitor.nextProductUrl, productA.productUrl);
      assert.equal(local.monitor.nextProductUrl, productA.productUrl);
      await worker.runCheck();
      assert.deepEqual(navigationHistory, [productA.productUrl]);
      assert.equal(local.monitor.nextProductUrl, productB.productUrl);
    });
  });
});
