import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_URL } from '../extension/core.js';

const NEXT = 'ichwillnixverpassen-next-check';
const WATCHDOG = 'ichwillnixverpassen-check-watchdog';
const primaryShopOrigins = ['https://shop.example/*'];
const credentials = {
  productUrl: DEFAULT_URL,
  productTitle: 'Kabellose Kopfhörer',
  botToken: '123456:private-test-token',
  chatId: '123456',
};
const productA = { productUrl: DEFAULT_URL, productTitle: 'Kabellose Kopfhörer' };
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
  const alarmState = new Map((initial.alarms || []).map(alarm => [alarm.name, { ...alarm }]));
  const alarmCalls = [];
  const local = storageArea(initial.local);
  const session = storageArea(initial.session);
  let origin = 1;
  let reloadCount = 0;
  let blockReload = null;
  let inspectionStatus = 'unavailable';
  let inspectionCount = 0;
  const inspectionHistory = [];
  const inspectionArguments = [];
  const navigationHistory = [];
  const tabQueries = [];
  const grantedOrigins = new Set(['https://api.telegram.org/*', ...(initial.origins || [])]);
  const statusesByUrl = new Map();
  const failedNavigations = new Set();
  const configured = initial.local?.settings?.products || [productA];
  const initialTabs = initial.tabs || configured.map((product, index) => ({ id: index + 1, url: product.productUrl, status: 'complete' }));
  const tabs = new Map(initialTabs.map(tab => [tab.id, tab]));
  const chrome = {
    storage: { local, session },
    permissions: {
      async contains({ origins }) { return origins.every(origin => grantedOrigins.has(origin)); },
    },
    runtime: {
      id: 'local-shop-test',
      getURL: path => `chrome-extension://local-shop-test/${path}`,
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
      async getAll() { return [...alarmState.values()].map(alarm => ({ ...alarm })); },
      async create(name, options) {
        alarmCalls.push({ name, ...options });
        alarmState.set(name, { name, scheduledTime: options.when });
      },
      async clear(name) { return alarmState.delete(name); },
    },
    tabs: {
      async query({ url }) {
        tabQueries.push(url);
        return [...tabs.values()].filter(tab => {
          const parsed = new URL(tab.url);
          return `${parsed.protocol}//${parsed.hostname}/*` === url;
        }).map(tab => ({ ...tab }));
      },
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
          inspectionArguments.push(structuredClone(args[0]));
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
      inspectionArguments,
      tabQueries,
      grantedOrigins,
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
  await withWorker({ origins: primaryShopOrigins }, async ({ worker, local, alarmState, reloadCount }) => {
    await assert.rejects(worker.handleMessage({ type: 'START' }), /Bot-Token|Chat-ID/);
    assert.notEqual(local.monitor?.enabled, true);
    assert.equal(alarmState.has(NEXT), false);
    assert.equal(reloadCount(), 0);
  });
});

test('Extension worker: Telegram-Freigabe allein erlaubt keinen Zugriff auf einen konfigurierten Shop', async () => {
  await withWorker({ origins: [], local: { settings: credentials } }, async ({ worker, local, grantedOrigins, alarmState, navigationHistory }) => {
    assert.deepEqual([...grantedOrigins], ['https://api.telegram.org/*']);
    await assert.rejects(worker.handleMessage({ type: 'START' }), /Zugriff.*shop\.example/);
    assert.notEqual(local.monitor?.enabled, true);
    assert.equal(alarmState.has(NEXT), false);
    assert.deepEqual(navigationHistory, []);
  });
});

test('Extension worker: Status enthält keinen Token; Speichern mit leerem Feld erhält ihn', async () => {
  await withWorker({ origins: primaryShopOrigins, local: { settings: credentials } }, async ({ worker, local }) => {
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
  await withWorker({ origins: primaryShopOrigins, local: { settings: credentials, monitor: { enabled: true } } }, async ({ worker, alarmState }) => {
    const status = await worker.getStatus();
    const next = alarmState.get(NEXT);
    assert.ok(next.scheduledTime >= before + 900000);
    assert.ok(next.scheduledTime <= Date.now() + 1800000);
    assert.equal(status.monitor.nextCheckAt, next.scheduledTime);
    assert.equal(status.monitor.enabled, true);
  });
});

test('Extension worker: Upgrade entfernt unbekannte Alarme und erhält den gespeicherten nächsten Termin', async () => {
  const nextCheckAt = Date.now() + 20 * 60000;
  const oldAlarmNames = ['legacy-shop-check', 'legacy-shop-watchdog', 'obsolete-periodic-task'];
  await withWorker({
    origins: primaryShopOrigins,
    alarms: oldAlarmNames.map((name, index) => ({ name, scheduledTime: nextCheckAt - index * 1000 })),
    local: { settings: credentials, monitor: { enabled: true, nextCheckAt } },
  }, async ({ worker, chrome, alarmState, navigationHistory, restartWorker }) => {
    for (const name of oldAlarmNames) assert.equal(alarmState.has(name), false, `Alter Alarm ${name} muss entfernt sein`);
    assert.deepEqual([...alarmState.keys()], [NEXT]);
    assert.equal(alarmState.get(NEXT).scheduledTime, nextCheckAt, 'Ein noch zukünftiger Termin muss beim Upgrade exakt erhalten bleiben');
    assert.equal((await worker.getStatus()).monitor.nextCheckAt, nextCheckAt);
    assert.deepEqual(navigationHistory, [], 'Das Upgrade allein darf keine Produktseite laden');
    const restarted = await restartWorker();
    assert.equal((await restarted.getStatus()).monitor.nextCheckAt, nextCheckAt);
    assert.deepEqual((await chrome.alarms.getAll()).map(alarm => alarm.name), [NEXT]);
  });
});

test('Extension worker: Upgrade eines gestoppten Monitors entfernt alte Alarme ohne neuen Prüftermin', async () => {
  await withWorker({
    origins: primaryShopOrigins,
    alarms: [{ name: 'legacy-shop-check', scheduledTime: Date.now() + 60000 }],
    local: { settings: credentials, monitor: { enabled: false, nextCheckAt: null } },
  }, async ({ worker, alarmState, alarmCalls, navigationHistory }) => {
    assert.equal(alarmState.size, 0);
    assert.equal(alarmCalls.length, 0);
    assert.equal((await worker.getStatus()).monitor.enabled, false);
    assert.deepEqual(navigationHistory, []);
  });
});

test('Extension worker: Stop leert den Termin, auch wenn eine Prüfung noch läuft', async () => {
  await withWorker({ origins: primaryShopOrigins, local: { settings: credentials, monitor: { enabled: true } } }, async ({ worker, alarmState, alarmCalls, reloadCount, setReloadGate }) => {
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
  await withWorker({ origins: primaryShopOrigins,
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
  await withWorker({ origins: primaryShopOrigins,
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
  await withWorker({ origins: primaryShopOrigins, local: { settings: credentials } }, async ({ chrome }) => {
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
  await withWorker({ origins: primaryShopOrigins, fastTimers: true, local: { settings: credentials } }, async ({ worker, chrome, reloadCount, inspectionCount }) => {
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
  await withWorker({ origins: primaryShopOrigins, fastTimers: true, local: { settings: credentials, monitor: { enabled: true } } }, async ({ worker, chrome, local, alarmState }) => {
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
  await withWorker({ origins: primaryShopOrigins,
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
  await withWorker({ origins: primaryShopOrigins, fastTimers: true, local: { settings: credentials, monitor: { enabled: true } } }, async ({ worker, chrome, session, alarmState, reloadCount, inspectionCount, setFetch }) => {
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
  await withWorker({ origins: primaryShopOrigins,
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

test('Extension worker: Migration normalisiert den Slash und erhält Query- und Fragmentvarianten ohne erneuten Alarm', async t => {
  for (const [variant, oldUrl, canonicalUrl] of [
    ['Basisprodukt', `${DEFAULT_URL}/`, DEFAULT_URL],
    ['Variante', `${DEFAULT_URL}/?variant=blue#large`, `${DEFAULT_URL}?variant=blue#large`],
  ]) for (const [name, previous] of [
    ['bisheriger Einzelstatus', { lastProductState: { url: oldUrl, status: 'available' } }],
    ['bereits gespeicherte Status-Map', { lastProductStates: { [oldUrl]: { url: oldUrl, status: 'available' } } }],
  ]) {
    await t.test(`${variant}: ${name}`, async () => {
      await withWorker({ origins: primaryShopOrigins,
        fastTimers: true,
        local: { settings: { ...credentials, productUrl: oldUrl }, ...previous },
      }, async ({ worker, local, setInspectionStatus, setFetch }) => {
        const status = await worker.getStatus();
        assert.equal(status.settings.products[0].productUrl, canonicalUrl);
        assert.deepEqual(local.lastProductStates[canonicalUrl], { url: canonicalUrl, status: 'available' });
        assert.equal(Object.hasOwn(local.lastProductStates, oldUrl), false);
        let sends = 0;
        setFetch(async () => { sends++; throw new Error('URL-Kanonisierung darf einen bestehenden Alarm nicht wiederholen.'); });
        setInspectionStatus('available');
        await worker.runCheck();
        assert.equal(sends, 0);
        assert.equal(local.lastProductStates[canonicalUrl].status, 'available');
      });
    });
  }
});

test('Extension worker: Rotation prüft pro Lauf genau ein Produkt und dedupliziert pro URL', async () => {
  await withWorker({ origins: primaryShopOrigins,
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
  await withWorker({ origins: primaryShopOrigins,
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
  await withWorker({ origins: primaryShopOrigins,
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
  await withWorker({ origins: primaryShopOrigins,
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
    await withWorker({ origins: primaryShopOrigins,
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
    await withWorker({ origins: primaryShopOrigins,
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

test('Extension worker: Verschiedene Shops rotieren mit eigenen Tabs, Regeln und Meldestatus', async () => {
  const other = {
    productUrl: 'https://shop.example.test/products/box?variant=blue', productTitle: 'Andere Box',
    buttonSelector: '#purchase', buttonText: 'Jetzt bestellen',
  };
  await withWorker({
    fastTimers: true,
    origins: ['https://shop.example/*', 'https://shop.example.test/*'],
    local: { settings: { ...credentials, products: [productA, other] } },
  }, async ({ worker, local, navigationHistory, inspectionArguments, tabQueries, setInspectionStatus, setFetch }) => {
    const messages = [];
    setInspectionStatus('available');
    setFetch(async (_url, options) => {
      messages.push(JSON.parse(options.body).text);
      return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
    });
    for (let index = 0; index < 4; index++) await worker.runCheck();
    assert.deepEqual(navigationHistory, [productA.productUrl, other.productUrl, productA.productUrl, other.productUrl]);
    assert.ok(tabQueries.includes('https://shop.example.test/*'));
    const otherArguments = inspectionArguments.find(args => args.productUrl === other.productUrl);
    assert.deepEqual(otherArguments, other);
    assert.equal(JSON.stringify(inspectionArguments).includes(credentials.botToken), false);
    assert.equal(messages.length, 2);
    assert.match(messages[1], /^IchWillNixVerpassen:/);
    assert.ok(messages[1].includes(other.productUrl));
    assert.equal(local.lastProductStates[other.productUrl].status, 'available');
  });
});

test('Extension worker: Fehlende Shopfreigabe verhindert Speichern und Start ohne alte Daten zu ändern', async () => {
  const other = { productUrl: 'https://shop.example.test/box', productTitle: 'Andere Box' };
  await withWorker({ origins: primaryShopOrigins, local: { settings: credentials } }, async ({ worker, local, grantedOrigins, alarmState }) => {
    await assert.rejects(worker.handleMessage({ type: 'SAVE_SETTINGS', payload: { products: [other] } }), /Zugriff.*shop\.example\.test.*speichern/);
    assert.deepEqual(local.settings.products, [productA]);
    assert.equal(local.settings.botToken, credentials.botToken);
    grantedOrigins.add('https://shop.example.test/*');
    await worker.handleMessage({ type: 'SAVE_SETTINGS', payload: { products: [other] } });
    assert.deepEqual(local.settings.products, [other]);
    grantedOrigins.delete('https://shop.example.test/*');
    await assert.rejects(worker.handleMessage({ type: 'START' }), /Zugriff/);
    assert.notEqual(local.monitor.enabled, true);
    assert.equal(alarmState.has(NEXT), false);
  });
});

test('Extension worker: Entzogene Shopfreigabe navigiert nicht und blockiert die übrige Rotation nicht', async () => {
  const other = { productUrl: 'https://shop.example.test/box', productTitle: 'Andere Box' };
  await withWorker({ origins: primaryShopOrigins,
    fastTimers: true,
    local: { settings: { ...credentials, products: [other, productA] }, monitor: { enabled: true } },
  }, async ({ worker, local, navigationHistory, inspectionCount, alarmState }) => {
    await worker.runCheck();
    assert.deepEqual(navigationHistory, []);
    assert.equal(inspectionCount(), 0);
    assert.match(local.productResults[other.productUrl].lastError, /Zugriff/);
    assert.equal(local.monitor.nextProductUrl, productA.productUrl);
    assert.equal(alarmState.has(NEXT), true);
    await worker.runCheck();
    assert.deepEqual(navigationHistory, [productA.productUrl]);
    assert.equal(local.productResults[productA.productUrl].status, 'unavailable');
  });
});

test('Extension worker: Gleiches Produkt mit anderer URL-Variante verwendet nicht den falschen Tab', async () => {
  const blue = { productUrl: 'https://shop.example.test/box?variant=blue#buy', productTitle: 'Blaue Box' };
  const redUrl = 'https://shop.example.test/box?variant=red#buy';
  await withWorker({
    fastTimers: true,
    origins: ['https://shop.example.test/*'],
    local: { settings: { ...credentials, products: [blue] } },
    tabs: [{ id: 1, url: redUrl, status: 'complete' }],
  }, async ({ worker, navigationHistory, reloadCount, inspectionHistory }) => {
    await worker.runCheck();
    assert.deepEqual(navigationHistory, [blue.productUrl]);
    assert.equal(reloadCount(), 0);
    assert.deepEqual(new Set(inspectionHistory), new Set([blue.productUrl]));
  });
});

test('Extension worker: Stop während der Befehlsvorbereitung verhindert eine verspätete Sofortprüfung', async () => {
  await withWorker({ origins: primaryShopOrigins, fastTimers: true, local: { settings: credentials, monitor: { enabled: true } } }, async ({ worker, chrome, reloadCount, inspectionCount }) => {
    const originalGet = chrome.storage.local.get;
    let waiting = false;
    let intercepted = false;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    chrome.storage.local.get = async keys => {
      const snapshot = await originalGet(keys);
      if (!intercepted && Array.isArray(keys) && keys.includes('settings')) {
        intercepted = true;
        waiting = true;
        await gate;
      }
      return snapshot;
    };
    const pending = worker.handleMessage({ type: 'CHECK_NOW' }).then(value => ({ value }), error => ({ error }));
    await spinUntil(() => waiting);
    await worker.handleMessage({ type: 'STOP' });
    release();
    const result = await pending;
    assert.match(result.error?.message || '', /beendet/);
    assert.equal(reloadCount(), 0);
    assert.equal(inspectionCount(), 0);
    assert.equal((await worker.getStatus()).monitor.enabled, false);
  });
});

test('Extension worker: Stop während eines Alarm-Speicherlesens verhindert eine Prüfung aus einem alten Aktiv-Snapshot', async () => {
  await withWorker({ origins: primaryShopOrigins, fastTimers: true, local: { settings: credentials, monitor: { enabled: true } } }, async ({ worker, chrome, alarmState, navigationHistory, inspectionCount, setFetch }) => {
    const originalGet = chrome.storage.local.get;
    let waiting = false;
    let intercepted = false;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    chrome.storage.local.get = async keys => {
      const snapshot = await originalGet(keys);
      if (!intercepted && Array.isArray(keys) && keys.includes('settings')) {
        intercepted = true;
        waiting = true;
        await gate;
      }
      return snapshot;
    };
    let sends = 0;
    setFetch(async () => { sends++; throw new Error('Ein bereits gestoppter Alarm darf keine Nachricht senden.'); });
    chrome.alarms.onAlarm.listeners[0]({ name: NEXT });
    await spinUntil(() => waiting);
    await worker.handleMessage({ type: 'STOP' });
    release();
    // Drain the released handler's promise continuations without advancing the
    // fake worker's inspection timers or relying on an arbitrary sleep.
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(navigationHistory, []);
    assert.equal(inspectionCount(), 0);
    assert.equal(sends, 0);
    assert.equal(alarmState.has(NEXT), false);
    assert.equal(alarmState.has(WATCHDOG), false);
    const status = await worker.getStatus();
    assert.equal(status.monitor.enabled, false);
    assert.equal(status.monitor.checking, false);
    assert.equal(status.monitor.nextCheckAt, null);
  });
});

test('Extension worker: Mehr als zehn Artikel werden gespeichert und über Neustarts vollständig weiterrotiert', async () => {
  const products = Array.from({ length: 12 }, (_, index) => ({
    productUrl: `${DEFAULT_URL}-artikel-${index + 1}`,
    productTitle: `Artikel ${index + 1}`,
  }));
  await withWorker({ origins: primaryShopOrigins, fastTimers: true, local: { settings: credentials } }, async ({ worker, local, navigationHistory, restartWorker, setFetch }) => {
    let requests = 0;
    setFetch(async () => { requests++; throw new Error('Nicht lieferbare Artikel dürfen keine Telegram-Nachricht auslösen.'); });
    const saved = await worker.handleMessage({ type: 'SAVE_SETTINGS', payload: { products } });
    assert.deepEqual(saved.settings.products, products);
    assert.deepEqual(local.settings.products, products);
    assert.equal(saved.productStatuses.length, 12, 'Auch die Statusliste darf nicht bei zehn Artikeln abgeschnitten werden');

    for (let index = 0; index < 10; index++) await worker.runCheck();
    assert.deepEqual(navigationHistory, products.slice(0, 10).map(product => product.productUrl));
    assert.equal(local.monitor.nextProductUrl, products[10].productUrl, 'Nach Artikel zehn muss Artikel elf folgen');

    const restarted = await restartWorker();
    assert.equal((await restarted.getStatus()).monitor.nextProductUrl, products[10].productUrl);
    await restarted.runCheck();
    assert.equal(navigationHistory.at(-1), products[10].productUrl, 'Der Worker-Neustart darf Artikel elf nicht überspringen');
    assert.equal(local.monitor.nextProductUrl, products[11].productUrl);
    await restarted.runCheck();
    assert.deepEqual(navigationHistory, products.map(product => product.productUrl));
    assert.equal(local.monitor.nextProductUrl, products[0].productUrl, 'Nach dem letzten Artikel geht es wieder beim ersten weiter');
    await restarted.runCheck();
    assert.deepEqual(navigationHistory, [...products.map(product => product.productUrl), products[0].productUrl]);
    assert.equal(local.monitor.nextProductUrl, products[1].productUrl);
    for (const product of products) assert.equal(local.lastProductStates[product.productUrl].status, 'unavailable');
    assert.equal(requests, 0);
  });
});
