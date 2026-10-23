import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import {
  DEFAULT_URL,
  normalizeSettings,
  chooseDelayMs,
  shouldNotify,
  inspectProduct,
} from '../extension/core.js';

test('Erweiterung: Einstellungen beschränken das Ziel und erhalten einen gespeicherten Token', () => {
  const previous = {
    productUrl: DEFAULT_URL,
    productTitle: 'Delta-Herrschaft',
    botToken: '123456:test-token',
    chatId: '123456',
  };
  const actual = normalizeSettings({
    productUrl: ` ${DEFAULT_URL} `,
    productTitle: ' Delta-Herrschaft ',
    botToken: '',
    chatId: ' -100123456 ',
  }, previous);
  assert.equal(actual.products[0].productUrl, DEFAULT_URL);
  assert.equal(actual.products[0].productTitle, 'Delta-Herrschaft');
  assert.equal(actual.botToken, previous.botToken);
  assert.equal(actual.chatId, '-100123456');
  const replaced = normalizeSettings({ ...actual, botToken: '789012:new-token' }, previous);
  assert.equal(replaced.botToken, '789012:new-token');

  for (const productUrl of [
    DEFAULT_URL.replace('https:', 'http:'),
    DEFAULT_URL.replace('www.pokemoncenter.com', 'example.com'),
    DEFAULT_URL.replace('www.pokemoncenter.com', 'www.pokemoncenter.com.example.com'),
    DEFAULT_URL.replace('www.pokemoncenter.com', 'user:password@www.pokemoncenter.com'),
    'https://www.pokemoncenter.com/de-de/',
    'javascript:alert(1)',
  ]) {
    assert.throws(() => normalizeSettings({ ...previous, productUrl }), `Ziel muss abgewiesen werden: ${productUrl}`);
  }
});

test('Erweiterung: Jedes Zufallsintervall liegt einschließlich der Grenzen bei 15–30 Minuten', () => {
  assert.equal(chooseDelayMs(() => 0), 900000);
  assert.equal(chooseDelayMs(() => 1 - Number.EPSILON), 1800000);
  for (let i = 0; i < 100; i++) {
    const delay = chooseDelayMs();
    assert.ok(Number.isInteger(delay));
    assert.ok(delay >= 900000 && delay <= 1800000);
  }
});

test('Erweiterung: Bisherige Einzelprodukt-Einstellungen werden mit Standardzeiten migriert', () => {
  const migrated = normalizeSettings({}, {
    productUrl: `${DEFAULT_URL}/?old=1#details`,
    productTitle: ' Delta-Herrschaft ',
    botToken: 'saved-token',
    chatId: '123456',
  });
  assert.deepEqual(migrated.products, [{ productUrl: DEFAULT_URL, productTitle: 'Delta-Herrschaft' }]);
  assert.equal(migrated.botToken, 'saved-token');
  assert.equal(migrated.chatId, '123456');
  assert.equal(migrated.minMinutes, 15);
  assert.equal(migrated.maxMinutes, 30);
});

test('Erweiterung: Produktliste enthält höchstens zehn eindeutige kanonische Produkt-URLs', () => {
  const ten = Array.from({ length: 10 }, (_, index) => ({
    productUrl: `${DEFAULT_URL}-produkt-${index}`,
    productTitle: `Produkt ${index}`,
  }));
  assert.equal(normalizeSettings({ products: ten }).products.length, 10);
  assert.throws(() => normalizeSettings({ products: [] }));
  assert.throws(() => normalizeSettings({ products: [...ten, { productUrl: `${DEFAULT_URL}-extra`, productTitle: 'Extra Produkt' }] }));
  assert.throws(() => normalizeSettings({ products: [
    { productUrl: DEFAULT_URL, productTitle: 'Delta-Herrschaft' },
    { productUrl: `${DEFAULT_URL}/?variant=1#details`, productTitle: 'Gleiches Produkt' },
  ] }), 'Query, Fragment und abschließender Slash dürfen keine künstlich verschiedenen Produkte erzeugen');
  const canonical = normalizeSettings({ products: [{ productUrl: ` ${DEFAULT_URL}/?source=bookmark#details `, productTitle: ' Delta-Herrschaft ' }] });
  assert.deepEqual(canonical.products, [{ productUrl: DEFAULT_URL, productTitle: 'Delta-Herrschaft' }]);
});

test('Erweiterung: Benutzerdefinierte Zufallsgrenzen sind gültige Minutenwerte und gelten auch bei gleichem Min/Max', () => {
  const settings = normalizeSettings({ minMinutes: '2.50', maxMinutes: '7.75' });
  assert.equal(settings.minMinutes, 2.5);
  assert.equal(settings.maxMinutes, 7.75);
  assert.equal(chooseDelayMs(() => 0, settings.minMinutes, settings.maxMinutes), 150000);
  assert.equal(chooseDelayMs(() => 1 - Number.EPSILON, settings.minMinutes, settings.maxMinutes), 465000);
  for (let index = 0; index < 10; index++) assert.equal(chooseDelayMs(Math.random, 4.25, 4.25), 255000);
  assert.equal(normalizeSettings({ minMinutes: 1, maxMinutes: 1440 }).maxMinutes, 1440);
  for (const range of [
    { minMinutes: 0, maxMinutes: 1 },
    { minMinutes: 1, maxMinutes: 1440.01 },
    { minMinutes: 5, maxMinutes: 4 },
    { minMinutes: 1.001, maxMinutes: 2 },
    { minMinutes: 1, maxMinutes: 2.001 },
    { minMinutes: 'invalid', maxMinutes: 3 },
    { minMinutes: 1, maxMinutes: Infinity },
  ]) assert.throws(() => normalizeSettings(range), `Ungültiger Zeitraum: ${JSON.stringify(range)}`);
});

test('Erweiterung: Nur neuer bestätigter Bestand löst einen Alarm aus', () => {
  assert.equal(shouldNotify(null, DEFAULT_URL, 'available'), true);
  assert.equal(shouldNotify({ url: DEFAULT_URL, status: 'unavailable' }, DEFAULT_URL, 'available'), true);
  assert.equal(shouldNotify({ url: DEFAULT_URL, status: 'available' }, DEFAULT_URL, 'available'), false);
  assert.equal(shouldNotify({ url: DEFAULT_URL, status: 'available' }, `${DEFAULT_URL}-other`, 'available'), true);
  for (const status of ['unavailable', 'unknown']) {
    assert.equal(shouldNotify(null, DEFAULT_URL, status), false);
    assert.equal(shouldNotify({ url: DEFAULT_URL, status: 'available' }, DEFAULT_URL, status), false);
  }
});

test('Erweiterung: DOM-Prüfung erkennt Bedienbarkeit ohne Warenkorb-Klick', async t => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}),
  });
  try {
    const page = await browser.newPage();
    const settings = { productUrl: DEFAULT_URL, productTitle: 'Delta-Herrschaft' };
    let body = '';
    await page.route('**/*', route => route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html><body>${body}</body></html>`,
    }));
    const cases = [
      ['bedienbarer Button', '<button onclick="document.body.dataset.clicked=\'yes\'">In den Warenkorb</button>', 'available'],
      ['deaktivierter Button', '<button disabled>In den Warenkorb</button>', 'unavailable'],
      ['ARIA-deaktivierter Button', '<button aria-disabled="true">In den Warenkorb</button>', 'unavailable'],
      ['nicht verfügbar', '<button disabled>Nicht verfügbar</button>', 'unavailable'],
      ['Bestandstext', '<p>Momentan nicht verfügbar</p>', 'unavailable'],
      ['versteckter Button', '<button hidden>In den Warenkorb</button>', 'unknown'],
      ['CSS-versteckter Button', '<button style="display:none">In den Warenkorb</button>', 'unknown'],
      ['widersprüchliche Signale', '<button>In den Warenkorb</button><p>Momentan nicht verfügbar</p>', 'unknown'],
      ['mehrdeutige Buttons', '<button>In den Warenkorb</button><button>In den Warenkorb</button>', 'unknown'],
      ['Empfehlung mit h2', '<h2>Weitere Produkte</h2><button>In den Warenkorb</button>', 'unknown'],
      ['Empfehlung mit h3', '<section><h3>Pikachu</h3><button>In den Warenkorb</button></section>', 'unknown'],
      ['negative Bestandsanzeige einer Empfehlung', '<h2>Weitere Produkte</h2><p>Nicht verfügbar</p>', 'unknown'],
      ['deaktivierter Warenkorb einer Empfehlung', '<h2>Weitere Produkte</h2><button disabled>In den Warenkorb</button>', 'unknown'],
      ['deaktivierter Zielbutton vor Empfehlung', '<button disabled>In den Warenkorb</button><h2>Weitere Produkte</h2><p>Nicht verfügbar</p>', 'unavailable'],
      ['durch Cookie-Dialog verdeckt', '<button>In den Warenkorb</button><div style="position:fixed;inset:0;z-index:999;background:white">Cookies auswählen</div>', 'unknown'],
    ];
    for (const [name, fragment, expected] of cases) {
      await t.test(name, async () => {
        body = `<main><h1>Pokémon Center Top-Trainer-Box Delta-Herrschaft</h1>${fragment}</main>`;
        await page.goto(DEFAULT_URL);
        const result = await page.evaluate(inspectProduct, settings);
        assert.equal(result.status, expected);
        assert.equal(typeof result.reason, 'string');
        assert.equal(await page.locator('body').getAttribute('data-clicked'), null);
      });
    }

    for (const [name, html] of [
      ['leerer Seiteninhalt', ''],
      ['Schutzseite', '<h1>Der Zugriff ist vorübergehend eingeschränkt</h1>'],
      ['anderes Produkt', '<main><h1>Pikachu</h1><button>In den Warenkorb</button></main>'],
      ['fehlender Hauptinhalt', '<h1>Delta-Herrschaft</h1><button>In den Warenkorb</button>'],
      ['Button außerhalb des Produkts', '<main><h1>Delta-Herrschaft</h1></main><button>In den Warenkorb</button>'],
    ]) {
      await t.test(name, async () => {
        body = html;
        await page.goto(DEFAULT_URL);
        assert.equal((await page.evaluate(inspectProduct, settings)).status, 'unknown');
      });
    }

    await t.test('richtiger Inhalt unter falscher Produkt-URL', async () => {
      body = '<main><h1>Delta-Herrschaft</h1><button>In den Warenkorb</button></main>';
      await page.goto(`${DEFAULT_URL}-other`);
      assert.equal((await page.evaluate(inspectProduct, settings)).status, 'unknown');
    });
  } finally {
    await browser.close();
  }
});
