const $ = id => document.getElementById(id);
const fields = {
  minMinutes: $('min-minutes'),
  maxMinutes: $('max-minutes'),
  botToken: $('bot-token'),
  chatId: $('chat-id'),
};
const buttons = ['start', 'stop', 'check', 'save', 'save-from-status', 'list-chats', 'test-telegram', 'add-product'].map($);
const statusLabels = { available: 'Verfügbar', unavailable: 'Nicht verfügbar', unknown: 'Nicht eindeutig erkennbar' };
const productRows = [];
let nextRowId = 0;
let latest = null;
let busy = false;
let stopping = false;
let noticeVersion = 0;
let refreshing = false;
let initialized = false;
let cleanSnapshot = null;
let dirty = false;

async function request(type, payload) {
  const response = await chrome.runtime.sendMessage({ type, payload });
  if (!response?.ok) throw new Error(response?.error || 'Die Erweiterung ist gerade nicht erreichbar. Bitte die Seite erneut öffnen.');
  return response.data;
}

function showNotice(message, kind = '') {
  const notice = $('notice');
  notice.textContent = message;
  notice.className = `notice ${kind}`.trim();
  notice.hidden = !message;
}

function setTime(id, value) {
  const node = $(id);
  const date = value ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime())) {
    node.textContent = '—';
    node.removeAttribute('datetime');
    return;
  }
  node.dateTime = date.toISOString();
  node.textContent = date.toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'medium' });
}

function productList(settings) {
  if (Array.isArray(settings.products)) return settings.products;
  return settings.productUrl ? [{ productUrl: settings.productUrl, productTitle: settings.productTitle }] : [];
}

function readFormSettings() {
  return {
    products: productRows.map(row => ({ productUrl: row.productUrl.value.trim(), productTitle: row.productTitle.value.trim() })),
    minMinutes: Number(fields.minMinutes.value),
    maxMinutes: Number(fields.maxMinutes.value),
    botToken: fields.botToken.value.trim(),
    chatId: fields.chatId.value.trim(),
  };
}

function hasUnsavedChanges() {
  return initialized && cleanSnapshot !== null && JSON.stringify(readFormSettings()) !== cleanSnapshot;
}

function updateDirtyState() {
  dirty = hasUnsavedChanges();
  $('unsaved-status').hidden = !dirty;
  $('unsaved-form').hidden = !dirty;
  updateButtons();
}

function createProductRow(product = {}) {
  const id = ++nextRowId;
  const element = document.createElement('fieldset');
  element.className = 'product-editor';
  const legend = document.createElement('legend');
  element.append(legend);
  const inputs = {};
  for (const [key, labelText, type] of [
    ['productUrl', 'Produktseite', 'url'], ['productTitle', 'Produktname', 'text'],
  ]) {
    const field = document.createElement('div');
    field.className = 'field';
    const label = document.createElement('label');
    label.htmlFor = `${key}-${id}`;
    label.textContent = labelText;
    const input = document.createElement('input');
    input.id = label.htmlFor;
    input.type = type;
    input.required = true;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-describedby', 'product-help');
    input.value = product[key] || '';
    if (key === 'productUrl') {
      input.maxLength = 2048;
      input.placeholder = 'https://www.pokemoncenter.com/de-de/product/…';
    } else {
      input.maxLength = 240;
      input.placeholder = 'Zum Beispiel Delta-Herrschaft';
    }
    field.append(label, input);
    element.append(field);
    inputs[key] = input;
  }
  const actions = document.createElement('div');
  actions.className = 'actions';
  const row = { element, legend, ...inputs };
  for (const [key, text] of [['up', 'Nach oben'], ['down', 'Nach unten'], ['remove', 'Entfernen']]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    row[key] = button;
    actions.append(button);
  }
  element.append(actions);
  const move = direction => {
    if (busy || !initialized) return;
    const index = productRows.indexOf(row);
    const destination = index + direction;
    if (destination < 0 || destination >= productRows.length) return;
    [productRows[index], productRows[destination]] = [productRows[destination], productRows[index]];
    updateDirtyState();
  };
  row.up.addEventListener('click', () => move(-1));
  row.down.addEventListener('click', () => move(1));
  row.remove.addEventListener('click', () => {
    if (busy || !initialized || productRows.length < 2) return;
    productRows.splice(productRows.indexOf(row), 1);
    updateDirtyState();
  });
  return row;
}

function updateProductEditors() {
  const container = $('product-editors');
  // Move the existing input elements instead of replacing their entered values.
  const expected = productRows.map(row => row.element);
  if (expected.some((element, index) => container.children[index] !== element) || container.children.length !== expected.length) {
    container.replaceChildren(...expected);
  }
  for (const [index, row] of productRows.entries()) {
    const number = index + 1;
    row.legend.textContent = `Produkt ${number}`;
    row.up.disabled = busy || !initialized || index === 0;
    row.down.disabled = busy || !initialized || index === productRows.length - 1;
    row.remove.disabled = busy || !initialized || productRows.length === 1;
    row.up.setAttribute('aria-label', `Produkt ${number} nach oben verschieben`);
    row.down.setAttribute('aria-label', `Produkt ${number} nach unten verschieben`);
    row.remove.setAttribute('aria-label', `Produkt ${number} entfernen`);
  }
  $('product-count').textContent = `${productRows.length} von 10 Produkten`;
  $('add-product').disabled = busy || !initialized || productRows.length >= 10;
}

function renderProductStatuses(settings, entries = []) {
  const byUrl = new Map((Array.isArray(entries) ? entries : []).map(entry => [entry.productUrl, entry]));
  const list = $('product-statuses');
  list.replaceChildren();
  for (const product of productList(settings).slice(0, 10)) {
    const status = byUrl.get(product.productUrl) || {};
    const item = document.createElement('li');
    const heading = document.createElement('div');
    heading.className = 'product-status-heading';
    let safeLink = false;
    try {
      const url = new URL(product.productUrl);
      safeLink = url.protocol === 'https:' && url.hostname === 'www.pokemoncenter.com';
    } catch { /* A malformed stored URL is rendered as plain text. */ }
    const name = document.createElement(safeLink ? 'a' : 'span');
    name.className = 'product-status-name';
    name.textContent = product.productTitle || product.productUrl;
    if (safeLink) {
      name.href = product.productUrl;
      name.target = '_blank';
      name.rel = 'noreferrer';
    }
    const state = document.createElement('span');
    state.className = 'product-state';
    state.dataset.state = status.status || '';
    state.textContent = statusLabels[status.status] || 'Noch nicht geprüft';
    heading.append(name, state);
    item.append(heading);
    const lastCheck = status.lastCheckAt ? new Date(status.lastCheckAt) : null;
    const detail = document.createElement('p');
    detail.className = 'hint';
    detail.textContent = lastCheck && Number.isFinite(lastCheck.getTime())
      ? `Zuletzt geprüft: ${lastCheck.toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'medium' })}`
      : 'Für dieses Produkt liegt noch keine Prüfung vor.';
    item.append(detail);
    if (status.lastError) {
      const error = document.createElement('p');
      error.className = 'inline-error';
      error.textContent = status.lastError;
      item.append(error);
    }
    list.append(item);
  }
}

function updateButtons() {
  for (const button of buttons) button.disabled = busy || !initialized;
  updateProductEditors();
  // Stopping is a separate command: a long-running check must not lock it out.
  $('stop').disabled = !initialized || stopping || !(latest?.monitor?.enabled || latest?.monitor?.checking);
  if (!initialized || busy) return;
  const { monitor = {}, settings = {} } = latest || {};
  $('start').disabled = dirty || Boolean(monitor.enabled || monitor.checking);
  $('check').disabled = dirty || Boolean(monitor.checking);
  $('test-telegram').disabled = !settings.tokenConfigured || !settings.chatId;
  $('list-chats').disabled = !settings.tokenConfigured;
}

function renderStatus(data, fillFields) {
  latest = data;
  const settings = data.settings || {};
  const monitor = data.monitor || {};
  if (fillFields) {
    productRows.splice(0, productRows.length, ...productList(settings).slice(0, 10).map(createProductRow));
    if (!productRows.length) productRows.push(createProductRow());
    fields.minMinutes.value = settings.minMinutes ?? 15;
    fields.maxMinutes.value = settings.maxMinutes ?? 30;
    fields.chatId.value = settings.chatId || '';
    fields.botToken.value = '';
    cleanSnapshot = JSON.stringify(readFormSettings());
  }
  fields.botToken.placeholder = settings.tokenConfigured
    ? 'Token gespeichert – leer lassen, um ihn zu behalten'
    : 'Token von @BotFather';
  const badge = $('monitor-badge');
  badge.textContent = monitor.checking ? 'Prüfung läuft …' : monitor.enabled ? 'Aktiv' : 'Gestoppt';
  badge.dataset.state = monitor.checking ? 'checking' : monitor.enabled ? 'active' : 'stopped';
  $('last-status').textContent = statusLabels[monitor.lastStatus] || 'Noch nicht geprüft';
  $('last-status').dataset.state = monitor.lastStatus || '';
  $('last-product').textContent = monitor.lastProductTitle || '—';
  $('next-product').textContent = monitor.nextProductTitle || '—';
  $('checking-product').textContent = monitor.checking
    ? `Wird gerade geprüft: ${monitor.checkingProductTitle || 'nächstes Produkt'}` : '';
  $('checking-product').hidden = !monitor.checking;
  const min = Number(settings.minMinutes ?? 15);
  const max = Number(settings.maxMinutes ?? 30);
  const format = value => value.toLocaleString('de-DE', { maximumFractionDigits: 2 });
  $('saved-interval').textContent = min === max
    ? `Gespeicherter Abstand: ${format(min)} Minuten zwischen den Produktprüfungen.`
    : `Gespeicherter Abstand: zufällig ${format(min)} bis ${format(max)} Minuten zwischen den Produktprüfungen.`;
  setTime('last-check', monitor.lastCheckAt);
  setTime('next-check', monitor.enabled ? monitor.nextCheckAt : null);
  setTime('last-notification', monitor.lastNotificationAt);
  $('monitor-error').textContent = monitor.lastError || '';
  $('monitor-error').hidden = !monitor.lastError;
  renderProductStatuses(settings, data.productStatuses);
  const entries = Array.isArray(data.log) ? data.log.slice(0, 15) : [];
  const history = $('history');
  history.replaceChildren();
  for (const entry of entries) {
    const item = document.createElement('li');
    const time = document.createElement('time');
    const date = new Date(entry.at);
    if (Number.isFinite(date.getTime())) {
      time.dateTime = date.toISOString();
      time.textContent = date.toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'medium' });
    } else time.textContent = '—';
    const message = document.createElement('span');
    message.textContent = entry.message || '';
    item.append(time, message);
    history.append(item);
  }
  $('empty-history').hidden = entries.length > 0;
  updateDirtyState();
}

async function refreshStatus() {
  if (refreshing) return;
  refreshing = true;
  try {
    const data = await request('GET_STATUS');
    const firstLoad = !initialized;
    initialized = true;
    renderStatus(data, firstLoad);
    $('connection-error').hidden = true;
  } catch (error) {
    $('connection-error').textContent = error.message;
    $('connection-error').hidden = false;
  } finally { refreshing = false; }
}

async function perform(action, pendingMessage, onSuccess) {
  if (busy) return;
  const version = ++noticeVersion;
  busy = true;
  updateButtons();
  showNotice(pendingMessage, 'busy');
  try {
    const data = await action();
    const message = typeof onSuccess === 'function' ? onSuccess(data) : onSuccess;
    if (version === noticeVersion) showNotice(message || 'Erledigt.');
  } catch (error) {
    if (version === noticeVersion) showNotice(error.message, 'error');
  } finally {
    busy = false;
    await refreshStatus();
    updateButtons();
  }
}

$('settings-form').addEventListener('submit', event => {
  event.preventDefault();
  const minMinutes = Number(fields.minMinutes.value);
  const maxMinutes = Number(fields.maxMinutes.value);
  fields.maxMinutes.setCustomValidity(maxMinutes < minMinutes ? 'Der Bis-Wert muss mindestens so groß wie der Von-Wert sein.' : '');
  if (!$('settings-form').reportValidity()) return;
  if (productRows.length < 1 || productRows.length > 10) {
    showNotice('Bitte ein bis zehn verschiedene Produkte eintragen.', 'error');
    return;
  }
  const settings = readFormSettings();
  void perform(() => request('SAVE_SETTINGS', settings), 'Einstellungen werden gespeichert …', () => {
    // A user may continue editing while the save request is pending. Only the
    // submitted values become clean; later edits must remain marked unsaved.
    if (fields.botToken.value.trim() === settings.botToken) fields.botToken.value = '';
    cleanSnapshot = JSON.stringify({ ...settings, botToken: '' });
    updateDirtyState();
    return dirty ? 'Gespeichert. Weitere Änderungen sind noch ungespeichert.' : 'Einstellungen gespeichert.';
  });
});

$('settings-form').addEventListener('input', updateDirtyState);
$('settings-form').addEventListener('change', updateDirtyState);
$('save-from-status').addEventListener('click', () => {
  if (busy || !initialized) return;
  $('settings-form').requestSubmit();
});

for (const field of [fields.minMinutes, fields.maxMinutes]) {
  field.addEventListener('input', () => fields.maxMinutes.setCustomValidity(''));
}
$('add-product').addEventListener('click', () => {
  if (busy || !initialized || productRows.length >= 10) return;
  const row = createProductRow();
  productRows.push(row);
  updateDirtyState();
  row.productUrl.focus();
});

$('start').addEventListener('click', () => {
  if (!initialized) return;
  updateDirtyState();
  if (dirty) {
    showNotice('Ungespeicherte Änderungen – zuerst speichern.', 'error');
    return;
  }
  void perform(() => request('START'), 'Überwachung wird gestartet …', 'Überwachung gestartet. Die Produkte werden der Reihe nach geprüft.');
});
$('stop').addEventListener('click', async () => {
  if (!initialized || stopping || !(latest?.monitor?.enabled || latest?.monitor?.checking)) return;
  const version = ++noticeVersion;
  stopping = true;
  updateButtons();
  showNotice('Überwachung wird gestoppt …', 'busy');
  try {
    await request('STOP');
    if (version === noticeVersion) showNotice('Überwachung gestoppt.');
  } catch (error) {
    if (version === noticeVersion) showNotice(error.message, 'error');
  } finally {
    stopping = false;
    await refreshStatus();
    updateButtons();
  }
});
$('check').addEventListener('click', () => {
  if (!initialized) return;
  updateDirtyState();
  if (dirty) {
    showNotice('Ungespeicherte Änderungen – zuerst speichern.', 'error');
    return;
  }
  void perform(() => request('CHECK_NOW'), 'Das nächste Produkt wird geprüft … Das kann einen Moment dauern.', 'Prüfung abgeschlossen. Das Ergebnis steht unter „Status deiner Produkte“.');
});
$('test-telegram').addEventListener('click', () => {
  void perform(() => request('TEST_TELEGRAM'), 'Telegram-Testnachricht wird gesendet …', 'Testnachricht gesendet.');
});
$('list-chats').addEventListener('click', () => {
  void perform(() => request('LIST_CHATS'), 'Telegram-Chats werden gesucht …', chats => {
    const select = $('chats');
    select.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Chat auswählen …';
    select.append(placeholder);
    for (const chat of Array.isArray(chats) ? chats : []) {
      const option = document.createElement('option');
      option.value = String(chat.id);
      option.textContent = `${chat.name || 'Telegram-Chat'} (${chat.id})`;
      select.append(option);
    }
    const found = select.options.length > 1;
    $('chats-field').hidden = !found;
    return found
      ? 'Wähle unten deinen Chat aus und speichere die Einstellungen.'
      : 'Keine Chats gefunden. Sende deinem Bot in Telegram eine neue Nachricht und versuche es erneut.';
  });
});
$('chats').addEventListener('change', event => {
  if (!event.target.value) return;
  fields.chatId.value = event.target.value;
  updateDirtyState();
  showNotice('Chat-ID übernommen. Bitte Einstellungen speichern.');
});

window.addEventListener('beforeunload', event => {
  if (!hasUnsavedChanges()) return;
  event.preventDefault();
  event.returnValue = '';
});

void refreshStatus();
setInterval(() => { if (!document.hidden) void refreshStatus(); }, 2000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshStatus(); });
