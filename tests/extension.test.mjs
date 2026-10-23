import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import {
  DEFAULT_URL,
  normalizeSettings,
  chooseDelayMs,
  shouldNotify,
  inspectProduct,
  canonicalProductUrl,
  sameProductUrl,
  sitePermissionPattern,
} from '../extension/core.js';

test('Erweiterung: Einstellungen beschränken das Ziel und erhalten einen gespeicherten Token', () => {
  const previous = {
    productUrl: DEFAULT_URL,
    productTitle: 'Kabellose Kopfhörer',
    botToken: '123456:test-token',
    chatId: '123456',
  };
  const actual = normalizeSettings({
    productUrl: ` ${DEFAULT_URL} `,
    productTitle: ' Kabellose Kopfhörer ',
    botToken: '',
    chatId: ' -100123456 ',
  }, previous);
  assert.equal(actual.products[0].productUrl, DEFAULT_URL);
  assert.equal(actual.products[0].productTitle, 'Kabellose Kopfhörer');
  assert.equal(actual.botToken, previous.botToken);
  assert.equal(actual.chatId, '-100123456');
  const replaced = normalizeSettings({ ...actual, botToken: '789012:new-token' }, previous);
  assert.equal(replaced.botToken, '789012:new-token');

  for (const productUrl of [
    DEFAULT_URL.replace('shop.example', 'user:password@shop.example'),
    'javascript:alert(1)',
    'file:///tmp/product.html',
    'data:text/html,Product',
    'not a URL',
    'https://*/kopfhoerer',
    'https://*.example.test/kopfhoerer',
    `https://shop.example/${'x'.repeat(2048)}`,
  ]) {
    assert.throws(() => normalizeSettings({ ...previous, productUrl }), `Ziel muss abgewiesen werden: ${productUrl}`);
  }
});

test('Erweiterung: Alle Shops behalten Produktvarianten in Query und Fragment', () => {
  for (const productUrl of [
    'https://shop.example/products/kopfhoerer?variant=blue#large',
    'http://shop.example:8080/products/kopfhoerer?variant=red#small',
    'https://another-shop.example/produkte?category=audio#new',
  ]) {
    const normalized = normalizeSettings({ products: [{ productUrl, productTitle: 'Kopfhörer' }] });
    assert.equal(normalized.products[0].productUrl, productUrl);
  }
  const variants = normalizeSettings({ products: [
    { productUrl: 'https://shop.example/kopfhoerer?variant=blue#large', productTitle: 'Blaue Kopfhörer' },
    { productUrl: 'https://shop.example/kopfhoerer?variant=red#large', productTitle: 'Rote Kopfhörer' },
    { productUrl: 'https://shop.example/kopfhoerer?variant=blue#small', productTitle: 'Kleine Kopfhörer' },
  ] });
  assert.equal(variants.products.length, 3);
  assert.equal(canonicalProductUrl('https://shop.example/kopfhoerer/?variant=blue#large'), 'https://shop.example/kopfhoerer?variant=blue#large');
  assert.equal(canonicalProductUrl('https://shop.example/'), 'https://shop.example/');
  assert.equal(canonicalProductUrl(`${DEFAULT_URL}/?variant=blue#large`), `${DEFAULT_URL}?variant=blue#large`, 'Auch die Standardadresse erhält Query und Fragment als Produktvariante');
});

test('Erweiterung: URL-Vergleich ist sicher und Berechtigungen gelten für die konkrete Website', () => {
  assert.equal(sameProductUrl('https://shop.example/kopfhoerer/?variant=blue#large', 'https://shop.example/kopfhoerer?variant=blue#large'), true);
  assert.equal(sameProductUrl('https://shop.example/kopfhoerer?variant=blue', 'https://shop.example/kopfhoerer?variant=red'), false);
  assert.equal(sameProductUrl('https://shop.example/kopfhoerer#blue', 'https://shop.example/kopfhoerer#red'), false);
  assert.equal(sameProductUrl('https://shop.example/kopfhoerer', 'http://shop.example/kopfhoerer'), false);
  assert.equal(sameProductUrl(`${DEFAULT_URL}/?variant=blue#large`, DEFAULT_URL), false);
  assert.equal(sameProductUrl('not a URL', 'not a URL'), false);
  assert.equal(sameProductUrl('javascript:alert(1)', 'javascript:alert(1)'), false);
  assert.equal(sitePermissionPattern('https://shop.example:8443/kopfhoerer?variant=blue#large'), 'https://shop.example/*');
  assert.equal(sitePermissionPattern('http://localhost:8080/kopfhoerer'), 'http://localhost/*');
  assert.throws(() => sitePermissionPattern('file:///tmp/kopfhoerer'));
});

test('Erweiterung: Eigene Button-Auswahl ist optional, begrenzt und bleibt beim Speichern erhalten', () => {
  const product = { productUrl: 'https://shop.example/kopfhoerer', productTitle: 'Kopfhörer' };
  assert.deepEqual(normalizeSettings({ products: [{ ...product, buttonSelector: ' ', buttonText: '' }] }).products[0], product);
  const configured = normalizeSettings({ products: [{ ...product, buttonSelector: ' #order ', buttonText: ' Jetzt bestellen ' }] });
  assert.deepEqual(configured.products[0], { ...product, buttonSelector: '#order', buttonText: 'Jetzt bestellen' });
  assert.deepEqual(normalizeSettings({}, configured).products[0], configured.products[0]);
  assert.equal(normalizeSettings({ products: [{ ...product, buttonSelector: 'x'.repeat(512), buttonText: 'x'.repeat(240) }] }).products[0].buttonText.length, 240);
  for (const invalid of [
    { buttonSelector: 'x'.repeat(513) }, { buttonText: 'x'.repeat(241) },
    { buttonSelector: 3 }, { buttonText: { text: 'Bestellen' } },
  ]) assert.throws(() => normalizeSettings({ products: [{ ...product, ...invalid }] }));
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
  const defaults = normalizeSettings({});
  assert.equal(DEFAULT_URL, 'https://shop.example/produkt/kopfhoerer');
  assert.deepEqual(defaults.products, [{ productUrl: DEFAULT_URL, productTitle: 'Kabellose Kopfhörer' }]);
  const migrated = normalizeSettings({}, {
    productUrl: `${DEFAULT_URL}/?old=1#details`,
    productTitle: ' Kabellose Kopfhörer ',
    botToken: 'saved-token',
    chatId: '123456',
  });
  assert.deepEqual(migrated.products, [{ productUrl: `${DEFAULT_URL}?old=1#details`, productTitle: 'Kabellose Kopfhörer' }]);
  assert.equal(migrated.botToken, 'saved-token');
  assert.equal(migrated.chatId, '123456');
  assert.equal(migrated.minMinutes, 15);
  assert.equal(migrated.maxMinutes, 30);
});

test('Erweiterung: Produktliste erhält große Listen ohne feste Obergrenze und prüft eindeutige URLs', () => {
  const products = Array.from({ length: 125 }, (_, index) => ({
    productUrl: `${DEFAULT_URL}-produkt-${index}`,
    productTitle: `Produkt ${index}`,
  }));
  const actual = normalizeSettings({ products });
  assert.deepEqual(actual.products, products, 'Auch Einträge jenseits der bisherigen Zehnergrenze müssen vollständig erhalten bleiben');
  assert.deepEqual(normalizeSettings({}, actual).products, products, 'Erneutes Laden darf die Liste nicht kürzen');
  assert.throws(() => normalizeSettings({ products: [] }));
  assert.throws(() => normalizeSettings({ products: [...products, products[124]] }), /einmal/, 'Doppelte URLs bleiben auch am Ende großer Listen ungültig');
  assert.throws(() => normalizeSettings({ products: [
    { productUrl: DEFAULT_URL, productTitle: 'Kabellose Kopfhörer' },
    { productUrl: `${DEFAULT_URL}/`, productTitle: 'Gleiches Produkt' },
  ] }), 'Ein abschließender Slash darf kein künstlich verschiedenes Produkt erzeugen');
  const canonical = normalizeSettings({ products: [{ productUrl: ` ${DEFAULT_URL}/?source=bookmark#details `, productTitle: ' Kabellose Kopfhörer ' }] });
  assert.deepEqual(canonical.products, [{ productUrl: `${DEFAULT_URL}?source=bookmark#details`, productTitle: 'Kabellose Kopfhörer' }]);
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
    const settings = { productUrl: DEFAULT_URL, productTitle: 'Kabellose Kopfhörer' };
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
      ['Empfehlung mit h3', '<section><h3>Lautsprecher</h3><button>In den Warenkorb</button></section>', 'unknown'],
      ['negative Bestandsanzeige einer Empfehlung', '<h2>Weitere Produkte</h2><p>Nicht verfügbar</p>', 'unknown'],
      ['deaktivierter Warenkorb einer Empfehlung', '<h2>Weitere Produkte</h2><button disabled>In den Warenkorb</button>', 'unknown'],
      ['deaktivierter Zielbutton vor Empfehlung', '<button disabled>In den Warenkorb</button><h2>Weitere Produkte</h2><p>Nicht verfügbar</p>', 'unavailable'],
      ['durch Cookie-Dialog verdeckt', '<button>In den Warenkorb</button><div style="position:fixed;inset:0;z-index:999;background:white">Cookies auswählen</div>', 'unknown'],
    ];
    for (const [name, fragment, expected] of cases) {
      await t.test(name, async () => {
        body = `<main><h1>Kabellose Kopfhörer Studio Pro</h1>${fragment}</main>`;
        await page.goto(DEFAULT_URL);
        const result = await page.evaluate(inspectProduct, settings);
        assert.equal(result.status, expected, result.reason);
        assert.equal(typeof result.reason, 'string');
        assert.equal(await page.locator('body').getAttribute('data-clicked'), null);
      });
    }

    for (const [name, html] of [
      ['leerer Seiteninhalt', ''],
      ['Schutzseite', '<h1>Der Zugriff ist vorübergehend eingeschränkt</h1>'],
      ['anderes Produkt', '<main><h1>Lautsprecher</h1><button>In den Warenkorb</button></main>'],
      ['Button außerhalb des Produkts', '<main><h1>Kabellose Kopfhörer</h1></main><button>In den Warenkorb</button>'],
    ]) {
      await t.test(name, async () => {
        body = html;
        await page.goto(DEFAULT_URL);
        assert.equal((await page.evaluate(inspectProduct, settings)).status, 'unknown');
      });
    }

    await t.test('richtiger Inhalt unter falscher Produkt-URL', async () => {
      body = '<main><h1>Kabellose Kopfhörer</h1><button>In den Warenkorb</button></main>';
      await page.goto(`${DEFAULT_URL}-other`);
      assert.equal((await page.evaluate(inspectProduct, settings)).status, 'unknown');
    });
  } finally {
    await browser.close();
  }
});

test('Erweiterung: Andere Shops und eigene Warenkorb-Auswahl bleiben eindeutig und klicken nichts', async t => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}),
  });
  try {
    const page = await browser.newPage();
    const target = 'https://shop.example/products/kopfhoerer?variant=blue#large';
    const settings = { productUrl: target, productTitle: 'Kabellose Kopfhörer' };
    let body = '';
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><body>${body}</body></html>` }));
    const gotoFixture = async url => {
      // A repeated navigation to a URL with a fragment can stay in the current
      // document. Leave it first so every case receives the current fixture HTML.
      await page.goto('about:blank');
      await page.goto(url);
    };
    const assertStatus = async (config, expected) => {
      const result = await page.evaluate(inspectProduct, config);
      assert.equal(result.status, expected, result.reason);
    };
    const cases = [
      ['einfacher Shop ohne main', '<h1>Kabellose Kopfhörer</h1><button>Add to cart</button>', {}, 'available'],
      ['Produktartikel ohne main', '<article><h1>Kabellose Kopfhörer</h1><button>In den Einkaufswagen</button></article>', {}, 'available'],
      ['kurzer eindeutiger Lieferstatus', '<h1>Kabellose Kopfhörer</h1><p>In stock</p>', {}, 'available'],
      ['Navigation ist kein Produktbutton', '<h1>Kabellose Kopfhörer</h1><footer><button>Add to cart</button></footer>', {}, 'unknown'],
      ['vorhandener main begrenzt die Auswahl', '<main><h1>Kabellose Kopfhörer</h1></main><button id="buy">Bestellen</button>', { buttonSelector: '#buy' }, 'unknown'],
      ['falsche Produktüberschrift trotz Selector', '<main><h1>Bluetooth Lautsprecher</h1><button id="buy">Bestellen</button></main>', { buttonSelector: '#buy' }, 'unknown'],
      ['Standarderkennung versteht Bestellaktion', '<main><h1>Kabellose Kopfhörer</h1><button id="buy">Jetzt bestellen</button></main>', {}, 'available'],
      ['exakter eigener Text ohne Selector', '<main><h1>Kabellose Kopfhörer</h1><button id="buy">Jetzt bestellen</button></main>', { buttonText: 'Jetzt bestellen' }, 'available'],
      ['Text bleibt exakt', '<main><h1>Kabellose Kopfhörer</h1><button>Jetzt bestellen – 20 €</button></main>', { buttonText: 'Jetzt bestellen' }, 'unknown'],
      ['Text bleibt in der Produktsektion', '<main><h1>Kabellose Kopfhörer</h1><h2>Andere Produkte</h2><button>Jetzt bestellen</button></main>', { buttonText: 'Jetzt bestellen' }, 'unknown'],
      ['Selector erlaubt eigene Beschriftung', '<main><h1>Kabellose Kopfhörer</h1><button id="buy">Jetzt bestellen</button></main>', { buttonSelector: '#buy' }, 'available'],
      ['Selector erlaubt Produkt-Unterüberschrift', '<main><h1>Kabellose Kopfhörer</h1><h2>Bestellmenge</h2><button id="buy">Jetzt bestellen</button></main>', { buttonSelector: '#buy' }, 'available'],
      ['Selector und Text stimmen', '<main><h1>Kabellose Kopfhörer</h1><button id="buy">Jetzt bestellen</button></main>', { buttonSelector: '#buy', buttonText: 'Jetzt bestellen' }, 'available'],
      ['Selector und Text widersprechen sich', '<main><h1>Kabellose Kopfhörer</h1><button id="buy">Benachrichtigen</button></main>', { buttonSelector: '#buy', buttonText: 'Jetzt bestellen' }, 'unknown'],
      ['Selector auf bedienbaren Link', '<main><h1>Kabellose Kopfhörer</h1><a id="buy" href="/order" onclick="document.body.dataset.clicked=\'yes\'">Bestellen</a></main>', { buttonSelector: '#buy' }, 'available'],
      ['Selector auf Bestandsabsatz reicht nicht', '<main><h1>Kabellose Kopfhörer</h1><p id="buy">Auf Lager</p></main>', { buttonSelector: '#buy' }, 'unknown'],
      ['bloßes Bestandswort wird nicht zu Bestellaktion', '<main><h1>Kabellose Kopfhörer</h1><button id="buy">In stock</button></main>', { buttonSelector: '#buy', buttonText: 'In stock' }, 'unknown'],
      ['fehlender Selector trifft nichts', '<main><h1>Kabellose Kopfhörer</h1><button>In den Warenkorb</button></main>', { buttonSelector: '#missing' }, 'unknown'],
      ['ungültiger Selector fällt nicht auf Auto zurück', '<main><h1>Kabellose Kopfhörer</h1><button>In den Warenkorb</button></main>', { buttonSelector: 'button[' }, 'unknown'],
      ['mehrdeutiger Selector bleibt unklar', '<main><h1>Kabellose Kopfhörer</h1><button class="buy">Bestellen</button><button class="buy">Bestellen</button></main>', { buttonSelector: '.buy' }, 'unknown'],
      ['versteckter zweiter Treffer ist kein sichtbarer Kandidat', '<main><h1>Kabellose Kopfhörer</h1><button class="buy">Bestellen</button><button hidden class="buy">Bestellen</button></main>', { buttonSelector: '.buy' }, 'available'],
      ['deaktivierter eigener Button', '<main><h1>Kabellose Kopfhörer</h1><button id="buy" disabled>Bestellen</button></main>', { buttonSelector: '#buy' }, 'unavailable'],
      ['deaktivierter eigener Link', '<main><h1>Kabellose Kopfhörer</h1><a id="buy" href="/order" aria-disabled="true">Bestellen</a></main>', { buttonSelector: '#buy' }, 'unavailable'],
      ['Bestandswiderspruch trotz Selector', '<main><h1>Kabellose Kopfhörer</h1><p>Sold out</p><button id="buy">Bestellen</button></main>', { buttonSelector: '#buy' }, 'unknown'],
      ['Negativtext trotz expliziter Einstellung', '<main><h1>Kabellose Kopfhörer</h1><button id="buy">Nicht verfügbar</button></main>', { buttonSelector: '#buy', buttonText: 'Nicht verfügbar' }, 'unavailable'],
      ['Overlay trotz Selector', '<main><h1>Kabellose Kopfhörer</h1><button id="buy">Bestellen</button></main><div style="position:fixed;inset:0;z-index:999;background:white">Cookies</div>', { buttonSelector: '#buy' }, 'unknown'],
    ];
    for (const [name, html, extra, expected] of cases) {
      await t.test(name, async () => {
        body = html;
        await gotoFixture(target);
        const result = await page.evaluate(inspectProduct, { ...settings, ...extra });
        assert.equal(result.status, expected, result.reason);
        assert.equal(await page.locator('body').getAttribute('data-clicked'), null);
        assert.equal(page.url(), target, 'Die Erkennung darf den Shop nicht navigieren');
      });
    }
    for (const otherUrl of [target.replace('blue', 'red'), target.replace('#large', '#small')]) {
      await t.test(`andere Variante ${otherUrl}`, async () => {
        body = '<main><h1>Kabellose Kopfhörer</h1><button>Add to cart</button></main>';
        await gotoFixture(otherUrl);
        await assertStatus(settings, 'unknown');
      });
    }
    await t.test('HTTP-Shop auf eigenem Port', async () => {
      const productUrl = 'http://shop.example:8080/kopfhoerer?variant=blue#large';
      body = '<h1>Kabellose Kopfhörer</h1><button>Add to basket</button>';
      await gotoFixture(productUrl);
      await assertStatus({ ...settings, productUrl }, 'available');
    });
    const jtlUrl = 'https://jtl-shop.example/produkt/kopfhoerer-studio-pro';
    const jtlSettings = { productUrl: jtlUrl, productTitle: 'Studio Pro' };
    const jtlPage = (controls, title = 'Kabellose Kopfhörer Studio Pro') => `
      <main id="main-wrapper"><div id="result-wrapper" itemtype="https://schema.org/Product" itemprop="mainEntity">
        <form id="buy_form"><div id="product-offer" class="product-detail">
          <div class="product-details"><div class="productdetails-headline"><h2 class="product-title h2" itemprop="name">${title}</h2></div>
            <h3>Inhalt</h3><p>Kabellose Kopfhörer mit Ladeetui.</p><h3>Informationen</h3><p>Deutsch.</p><h3>Lieferung</h3>
            ${controls}
          </div><section><h1>Studio Pro Kopfhörer</h1><p>Beschreibung der Kopfhörer.</p></section>
        </div></form>
      </div></main>`;
    for (const [name, controls, expected] of [
      ['JTL h2-Produktname mit Ausverkauft und deaktiviertem Button', '<span class="status status-0"><span class="fas"></span>Ausverkauft</span><div class="ausverkauft-inWarenkorb"><button disabled>In den Warenkorb</button></div>', 'unavailable'],
      ['JTL h2-Produktname mit negativem Status ohne Button', '<span class="status status-0">Ausverkauft</span>', 'unavailable'],
      ['JTL h2-Produktname mit Unterüberschriften und aktivem Button', '<span class="status status-1">Verfügbar</span><button onclick="document.body.dataset.clicked=\'yes\'">In den Warenkorb</button>', 'available'],
      ['JTL widersprüchlicher Bestand bleibt unklar', '<span class="status status-0">Ausverkauft</span><button>In den Warenkorb</button>', 'unknown'],
      ['JTL Empfehlung ist kein eigener Bestand', '<section><h2>Weitere Produkte</h2><span>Ausverkauft</span></section>', 'unknown'],
      ['JTL Empfehlungsbutton bleibt unklar', '<section itemtype="https://schema.org/Product"><h2 itemprop="name">Bluetooth Lautsprecher</h2><button>In den Warenkorb</button></section>', 'unknown'],
    ]) await t.test(name, async () => {
      body = jtlPage(controls);
      await gotoFixture(jtlUrl);
      await assertStatus(jtlSettings, expected);
      assert.equal(await page.locator('body').getAttribute('data-clicked'), null);
    });
    await t.test('JTL Beschreibung mit passendem h1 ersetzt keinen falschen Produktnamen', async () => {
      body = jtlPage('<button>In den Warenkorb</button>', 'Bluetooth Lautsprecher');
      await gotoFixture(jtlUrl);
      await assertStatus(jtlSettings, 'unknown');
    });
    await t.test('Semantischer Name einer Empfehlung nach der echten h1 reicht nicht als Produktidentität', async () => {
      body = '<main><h1>Bluetooth Lautsprecher</h1><section itemtype="https://schema.org/Product"><h2 itemprop="name">Kabellose Kopfhörer</h2><button>In den Warenkorb</button></section></main>';
      await gotoFixture(target);
      await assertStatus(settings, 'unknown');
    });
    const offer = { '@type': 'Offer', availability: 'https://schema.org/InStock' };
    const product = { '@type': 'Product', name: 'Kabellose Kopfhörer', url: target, offers: offer };
    const metadata = value => `<script type="application/ld+json">${JSON.stringify(value)}</script>`;
    const productHtml = contents => `<main><h1>Kabellose Kopfhörer</h1>${contents}</main>`;
    const stockCases = [
      ['Sofort lieferbar als kurzer Produktstatus', productHtml('<p>Sofort lieferbar</p>'), {}, 'available'],
      ['Auf Lager als kurzer Produktstatus', productHtml('<span>Auf Lager</span>'), {}, 'available'],
      ['Versandwerbung ist kein Lieferstatus', productHtml('<p>Kostenloser Versand verfügbar</p>'), {}, 'unknown'],
      ['ein beliebiger Satz mit lieferbar reicht nicht', productHtml('<p>Viele unserer Produkte sind sofort lieferbar.</p>'), {}, 'unknown'],
      ['Vorbestellung wird nicht als lieferbar gemeldet', productHtml('<p>Vorbestellbar</p><p>In stock</p>'), {}, 'unknown'],
      ['widersprüchliche kurze Lieferstatusangaben', productHtml('<p>In stock</p><p>Sold out</p>'), {}, 'unknown'],
      ['positiver Status aus Empfehlung reicht nicht', productHtml('<h2>Weitere Produkte</h2><p>Auf Lager</p>'), {}, 'unknown'],
      ['Bestelllink wird automatisch erkannt', productHtml('<a href="/order">Add to cart</a>'), {}, 'available'],
      ['englische Kaufaktion wird erkannt', productHtml('<button>Buy now</button>'), {}, 'available'],
      ['französische Warenkorbaktion wird erkannt', productHtml('<button>Ajouter au panier</button>'), {}, 'available'],
      ['CSS-deaktivierter Bestelllink', productHtml('<a class="disabled" href="/order">Add to cart</a>'), {}, 'unavailable'],
      ['Pointer-events-deaktivierter Button', productHtml('<button style="pointer-events:none">Buy now</button>'), {}, 'unavailable'],
      ['eigener Button plus Empfehlungsbutton bleibt eindeutig', productHtml('<button>Add to cart</button><h2>Weitere Produkte</h2><button>Add to cart</button>'), {}, 'available'],
      ['eigene h1 vor semantischer Empfehlung bleibt Produktidentität', productHtml('<button>Add to cart</button><section itemtype="https://schema.org/Product"><h2 itemprop="name">Lautsprecher</h2><button>Add to cart</button></section>'), {}, 'available'],
      ['eigener Selector darf keine Empfehlung übersteuern', productHtml('<h2>Weitere Produkte</h2><button id="other">Add to cart</button>'), { buttonSelector: '#other' }, 'unknown'],
      ['eigener Selector darf kein anderes semantisches Produkt auswählen', productHtml('<section itemtype="https://schema.org/Product"><h2 itemprop="name">Lautsprecher</h2><button id="other">Add to cart</button></section>'), { buttonSelector: '#other' }, 'unknown'],
      ['H1 im semantischen Produkt erlaubt Inhaltsüberschriften', '<main><article itemtype="https://schema.org/Product"><h1>Kabellose Kopfhörer</h1><h3>Lieferung</h3><button>In den Warenkorb</button></article></main>', {}, 'available'],
      ['H1 im semantischen Produkt schließt Empfehlungen aus', '<main><article itemtype="https://schema.org/Product"><h1>Kabellose Kopfhörer</h1><h3>Weitere Produkte</h3><button>In den Warenkorb</button></article></main>', {}, 'unknown'],
      ['JSON-LD eindeutiges Product mit Offer InStock', productHtml('') + metadata(product), {}, 'available'],
      ['JSON-LD falscher Produktname', productHtml('') + metadata({ ...product, name: 'Bluetooth Lautsprecher' }), {}, 'unknown'],
      ['JSON-LD andere Query-Variante', productHtml('') + metadata({ ...product, url: target.replace('blue', 'red') }), {}, 'unknown'],
      ['JSON-LD andere Fragment-Variante', productHtml('') + metadata({ ...product, url: target.replace('#large', '#small') }), {}, 'unknown'],
      ['JSON-LD Offer-URL andere Variante', productHtml('') + metadata({ ...product, offers: { ...offer, url: target.replace('blue', 'red') } }), {}, 'unknown'],
      ['JSON-LD Offer benennt explizit ein anderes Produkt', productHtml('') + metadata({ ...product, offers: { ...offer, itemOffered: { '@type': 'Product', name: 'Bluetooth Lautsprecher', url: 'https://shop.example/lautsprecher' } } }), {}, 'unknown'],
      ['JSON-LD nicht zugeordnete itemOffered-Referenz bleibt unklar', productHtml('') + metadata({ ...product, offers: { ...offer, itemOffered: { '@id': '#anderesProdukt' } } }), {}, 'unknown'],
      ['JSON-LD ohne Varianten-URL reicht nicht', productHtml('') + metadata({ ...product, url: undefined }), {}, 'unknown'],
      ['JSON-LD einer anderen gewählten Dropdown-Variante reicht nicht', '<main><h1>Kabellose Kopfhörer</h1><select><option value="blue" selected>Blau</option><option value="red">Rot</option></select></main>' + metadata({ ...product, name: 'Kabellose Kopfhörer Rot', url: target }), {}, 'unknown'],
      ['JSON-LD Offer-URL kann Variante eindeutig bestätigen', productHtml('') + metadata({ ...product, url: undefined, offers: { ...offer, url: target } }), {}, 'available'],
      ['JSON-LD null-URL bestätigt keine Variante', productHtml('') + metadata({ ...product, url: null }), {}, 'unknown'],
      ['JSON-LD AggregateOffer wird nicht als einzelner Bestand gewertet', productHtml('') + metadata({ ...product, offers: { '@type': 'AggregateOffer', availability: 'https://schema.org/InStock', offerCount: 8 } }), {}, 'unknown'],
      ['JSON-LD mehrere Angebote bleiben unklar', productHtml('') + metadata({ ...product, offers: [offer, { ...offer, availability: 'https://schema.org/OutOfStock' }] }), {}, 'unknown'],
      ['JSON-LD mehrere passende Produkte bleiben unklar', productHtml('') + metadata([product, product]), {}, 'unknown'],
      ['beliebiges JSON ist keine Product-Offerte', productHtml('') + metadata({ name: product.name, url: target, availability: 'https://schema.org/InStock' }), {}, 'unknown'],
      ['JSON-LD nur aus Empfehlung reicht nicht', productHtml('') + metadata({ ...product, name: 'Bluetooth Lautsprecher', url: 'https://shop.example/lautsprecher' }), {}, 'unknown'],
      ['JSON-LD mit Sicherheitsseite bleibt unklar', productHtml('<p>Verify you are human</p>') + metadata(product), {}, 'unknown'],
      ['JSON-LD ersetzt keine Produktüberschrift', '<main><h1>Access denied</h1></main>' + metadata(product), {}, 'unknown'],
      ['JSON-LD Graph mit referenziertem Offer', productHtml('') + metadata({ '@graph': [{ ...product, offers: { '@id': '#offer' } }, { ...offer, '@id': '#offer' }] }), {}, 'available'],
      ['JSON-LD OutOfStock ist nicht verfügbar', productHtml('') + metadata({ ...product, offers: { ...offer, availability: 'https://schema.org/OutOfStock' } }), {}, 'unavailable'],
      ['JSON-LD Vorbestellung bestätigt keine Lieferbarkeit', productHtml('') + metadata({ ...product, offers: { ...offer, availability: 'https://schema.org/PreOrder' } }), {}, 'unknown'],
      ['negativer Text übersteuert positive Metadaten', productHtml('<p>Ausverkauft</p>') + metadata(product), {}, 'unknown'],
      ['Nicht auf Lager übersteuert positive Metadaten', productHtml('<p>Nicht auf Lager</p>') + metadata(product), {}, 'unknown'],
      ['aktuell nicht lieferbar übersteuert positive Metadaten', productHtml('<p>Aktuell nicht lieferbar</p>') + metadata(product), {}, 'unknown'],
      ['deaktivierter Button übersteuert positive Metadaten', productHtml('<button disabled>Add to cart</button>') + metadata(product), {}, 'unavailable'],
      ['negative Metadaten widersprechen positivem Warenkorb', productHtml('<button>Add to cart</button>') + metadata({ ...product, offers: { ...offer, availability: 'https://schema.org/OutOfStock' } }), {}, 'unknown'],
      ['fehlende Variante übersteuert positive Metadaten', productHtml('<select required><option value="">Größe wählen</option><option value="L">L</option></select>') + metadata(product), {}, 'unknown'],
      ['fehlende Variante übersteuert positiven Button', productHtml('<select required><option value="">Größe wählen</option><option value="L">L</option></select><button>Buy now</button>'), {}, 'unknown'],
      ['unzugeordneter deaktivierter Button übersteuert Metadaten', productHtml('<h2>Bestellung</h2><button disabled>Buy now</button>') + metadata(product), {}, 'unknown'],
      ['enger Titelcontainer darf deaktivierten echten Button nicht übersehen', '<main itemscope itemtype="https://schema.org/Product"><div class="product-details"><h1 itemprop="name">Kabellose Kopfhörer</h1></div><button disabled>Add to cart</button></main>' + metadata(product), {}, 'unknown'],
      ['enger Titelcontainer darf negativen Lieferstatus nicht übersehen', '<main itemscope itemtype="https://schema.org/Product"><div class="product-details"><h1 itemprop="name">Kabellose Kopfhörer</h1></div><p>Nicht auf Lager</p></main>' + metadata(product), {}, 'unknown'],
      ['fehlende Radio-Auswahl übersteuert positiven Status', productHtml('<input type="radio" name="farbe" value="blau" required><p>Auf Lager</p>'), {}, 'unknown'],
      ['ausgewählte Variante kann positiven Status bestätigen', productHtml('<select required><option value="L" selected>L</option></select><p>Auf Lager</p>'), {}, 'available'],
      ['fehlender Custom-Selector fällt nicht auf Schema zurück', productHtml('') + metadata(product), { buttonSelector: '#missing' }, 'unknown'],
      ['fehlender Custom-Text fällt nicht auf Lieferstatus zurück', productHtml('<p>Auf Lager</p>') + metadata(product), { buttonText: 'Spezielle Kaufaktion' }, 'unknown'],
      ['Overlay übersteuert positive Metadaten', productHtml('') + metadata(product) + '<div style="position:fixed;inset:0;z-index:999;background:white">Cookies auswählen</div>', {}, 'unknown'],
      ['Overlay übersteuert positiven Lieferstatus', productHtml('<p>Auf Lager</p>') + '<div style="position:fixed;inset:0;z-index:999;background:white">Cookies auswählen</div>', {}, 'unknown'],
    ];
    for (const [name, html, extra, expected] of stockCases) await t.test(name, async () => {
      body = html;
      await gotoFixture(target);
      await assertStatus({ ...settings, ...extra }, expected);
    });
    const microdata = (stock = 'InStock', extra = '') => `<main><article itemscope itemtype="https://schema.org/Product">
      <h1 itemprop="name">Kabellose Kopfhörer</h1><link itemprop="url" href="${target}">
      <div itemprop="offers" itemscope itemtype="https://schema.org/Offer"><link itemprop="availability" href="https://schema.org/${stock}"></div>${extra}
      </article></main>`;
    for (const [name, html, expected] of [
      ['Microdata eindeutiges Product-Offer InStock', microdata(), 'available'],
      ['Microdata OutOfStock', microdata('OutOfStock'), 'unavailable'],
      ['Microdata und deaktivierter Warenkorb', microdata('InStock', '<button disabled>Add to cart</button>'), 'unavailable'],
      ['Microdata andere Variante', microdata().replace(`href="${target}"`, `href="${target.replace('blue', 'red')}"`), 'unknown'],
      ['Microdata widersprüchliche Verfügbarkeit', microdata().replace('</div>', '<link itemprop="availability" href="https://schema.org/OutOfStock"></div>'), 'unknown'],
      ['Microdata ProductGroup gilt nicht als einzelnes Produkt', microdata().replace('schema.org/Product', 'schema.org/ProductGroup'), 'unknown'],
      ['Microdata ProductModel gilt nicht als einzelnes Produkt', microdata().replace('schema.org/Product', 'schema.org/ProductModel'), 'unknown'],
      ['Microdata OfferCatalog gilt nicht als einzelnes Angebot', microdata().replace('schema.org/Offer', 'schema.org/OfferCatalog'), 'unknown'],
      ['Microdata OfferShippingDetails gilt nicht als einzelnes Angebot', microdata().replace('schema.org/Offer', 'schema.org/OfferShippingDetails'), 'unknown'],
    ]) await t.test(name, async () => {
      body = html;
      await gotoFixture(target);
      await assertStatus(settings, expected);
    });
    for (const [name, contents, extra, expected] of [
      ['Artikel kann derzeit nicht gekauft werden ist ein klares Negativsignal', '<p>Artikel kann derzeit nicht gekauft werden</p>', {}, 'unavailable'],
      ['Derzeit nicht erhältlich ist ein klares Negativsignal', '<p>Derzeit nicht erhältlich.</p>', {}, 'unavailable'],
      ['Currently unavailable ist ein klares Negativsignal', '<p>Currently unavailable.</p>', {}, 'unavailable'],
      ['Liefertermin unbekannt ist keine Lieferzusage', '<p>Liefertermin unbekannt</p>', {}, 'unknown'],
      ['Liefertermin unbekannt übersteuert aktiven Warenkorb', '<p>Liefertermin unbekannt</p><button>Add to cart</button>', {}, 'unknown'],
      ['Einladungsanfrage per Selector ist keine Kaufaktion', '<button id="invite">Einladung anfragen</button>', { buttonSelector: '#invite' }, 'unknown'],
      ['Einladungsanfrage per eigenem Text ist keine Kaufaktion', '<button>Request an invitation</button>', { buttonText: 'Request an invitation' }, 'unknown'],
      ['Benachrichtigungsanfrage per Selector ist keine Kaufaktion', '<button id="notify">Notify me when available</button>', { buttonSelector: '#notify' }, 'unknown'],
      ['Einladungsanfrage blockiert positive Metadaten ohne separate Negativphrase', `<button>Einladung anfragen</button>${metadata(product)}`, {}, 'unknown'],
      ['Benachrichtigungsanfrage blockiert positive Metadaten ohne separate Negativphrase', `<button>Benachrichtigen</button>${metadata(product)}`, {}, 'unknown'],
      ['Einladungsanfrage blockiert einen widersprüchlichen positiven Liefertext', '<p>In stock</p><button>Request an invitation</button>', {}, 'unknown'],
      ['Fremde Benachrichtigungsanfrage blockiert keinen echten positiven Liefertext', '<p>In stock</p><section class="recommendations"><button>Benachrichtigen</button></section>', {}, 'available'],
      ['Warenkorb und Sofortkauf in derselben Kaufbox', '<form><button>Add to cart</button><button>Buy now</button></form>', {}, 'available'],
      ['Warenkorb und Sofortkauf in verschiedenen Kaufboxen bleiben mehrdeutig', '<form><button>Add to cart</button></form><form><button>Buy now</button></form>', {}, 'unknown'],
      ['Zwei Warenkörbe in derselben Kaufbox bleiben mehrdeutig', '<form><button>Add to cart</button><button>Add to cart</button></form>', {}, 'unknown'],
      ['Warenkorb und Sofortkauf übersteuern kein negatives Bestandssignal', '<form><p>Out of stock</p><button>Add to cart</button><button>Buy now</button></form>', {}, 'unknown'],
    ]) await t.test(name, async () => {
      body = productHtml(contents);
      await gotoFixture(target);
      await assertStatus({ ...settings, ...extra }, expected);
    });

    const alternateUrl = 'https://www.alternate.de/Toshiba/N300-22-TB-Festplatte/html/product/100201167';
    const alternateTitle = 'Toshiba N300 22 TB, Festplatte (SATA 6 Gb/s, 3,5", Bulk)';
    const alternateSettings = { productUrl: alternateUrl, productTitle: alternateTitle };
    const alternatePage = (purchase, recommendation) => `<main>
      <div id="product-top"><div class="product-name"><h1>${alternateTitle}</h1></div>
        <div id="product-top-right"><p>Kapazität: <strong>22 TB</strong></p>
          <form id="add-to-cart-form">${purchase}</form>
        </div>
      </div>
      <section id="epoq_recommended" class="epoq-container"><div class="epoq-recommendations-widget">
        <h2>Andere Kapazitäten</h2><a href="/product/18tb">Toshiba N300 18 TB</a>${recommendation}
        <button disabled aria-disabled="true" aria-label="Vorherige Folie">Vorherige Folie</button>
      </div></section>
    </main>`;
    for (const [name, purchase, recommendation, expected, reason] of [
      ['Alternate: 22 TB nicht kaufbar trotz lieferbarer fremder Kapazität', '<div class="font-weight-bold text-center mt-3">Artikel kann derzeit nicht gekauft werden</div>', '<p>Sofort lieferbar</p><button>In den Warenkorb</button>', 'unavailable', /nicht gekauft werden/],
      ['Alternate: 22 TB wieder bestellbar trotz negativer fremder Kapazität', '<p>Sofort lieferbar</p><button onclick="document.body.dataset.clicked=\'yes\'">In den Warenkorb</button>', '<p>Artikel kann derzeit nicht gekauft werden</p>', 'available', /Warenkorb-Button/],
      ['Alternate: echter positiver Lieferstatus ignoriert deaktivierte Empfehlungsnavigation', '<p>Auf Lager</p>', '<p>Nicht auf Lager</p>', 'available', /Lieferstatus/],
      ['Alternate: unbekannter Zieltermin ignoriert positive fremde Kapazität', '<p>Liefertermin unbekannt</p>', '<p>Auf Lager</p>', 'unknown', /Liefertermin ist unbekannt/],
    ]) await t.test(name, async () => {
      body = alternatePage(purchase, recommendation);
      await gotoFixture(alternateUrl);
      const result = await page.evaluate(inspectProduct, alternateSettings);
      assert.equal(result.status, expected, result.reason);
      assert.match(result.reason, reason);
      assert.equal(await page.locator('body').getAttribute('data-clicked'), null);
      assert.equal(page.url(), alternateUrl);
    });

    const amazonUrl = 'https://www.amazon.de/dp/EXAMPLE1234';
    const amazonTitle = 'Kabellose Kopfhörer Studio Pro';
    const amazonSettings = { productUrl: amazonUrl, productTitle: amazonTitle };
    const amazonPage = (purchase, recommendation = '', title = amazonTitle) => `
      <header><h1>Zum Hauptinhalt springen</h1></header>
      <div id="dp-container" role="main"><h1>Produktinformationen</h1><div id="ppd">
        <div id="rightCol"><div id="desktop_buybox" data-feature-name="desktop_buybox"><div id="buybox">${purchase}</div></div></div>
        <div id="centerCol"><div id="title_feature_div"><h1 id="title"><span id="productTitle">${title}</span></h1></div></div>
        <div id="sims-consolidated-2_feature_div"><div data-a-carousel-options="{}"><h2>Empfohlene Artikel</h2>${recommendation}</div></div>
      </div><input type="hidden" id="productTitle" value="${amazonTitle}"><h1>Wichtige Informationen</h1></div>`;
    for (const [name, purchase, recommendation, expected, reason] of [
      ['Amazon: Hauptbuybox vor echtem Titel mit mehreren fremden h1 erkennt Einladung', '<div id="availability"><span>Auf Einladung erhältlich.</span></div><button id="hdp-invite-button-announce">Einladung anfragen</button>', '<p>Auf Lager</p><button>In den Einkaufswagen</button>', 'unavailable', /nur auf Einladung/],
      ['Amazon: Restock der Hauptbuybox bleibt trotz fremder Einladung erkennbar', '<div id="availability"><span>Auf Lager</span></div><button onclick="document.body.dataset.clicked=\'yes\'">In den Einkaufswagen</button>', '<p>Auf Einladung erhältlich.</p><button>Einladung anfragen</button>', 'available', /Warenkorb-Button/],
      ['Amazon: eindeutiger Hauptbestand ohne Button ignoriert fremde Einladung', '<div id="availability"><span>In stock</span></div>', '<p>Auf Einladung erhältlich.</p>', 'available', /Lieferstatus/],
      ['Amazon: Warenkorb und Sofortkauf in derselben Buybox', '<button>In den Einkaufswagen</button><button>Jetzt kaufen</button>', '<button>In den Einkaufswagen</button>', 'available', /Warenkorb-Button/],
      ['Amazon: derzeit nicht erhältlich in Hauptbuybox', '<div id="availability">Derzeit nicht erhältlich.</div>', '<p>Auf Lager</p>', 'unavailable', /nicht lieferbar/],
    ]) await t.test(name, async () => {
      body = amazonPage(purchase, recommendation);
      await gotoFixture(amazonUrl);
      const result = await page.evaluate(inspectProduct, amazonSettings);
      assert.equal(result.status, expected, result.reason);
      assert.match(result.reason, reason);
      assert.equal(await page.locator('body').getAttribute('data-clicked'), null);
      assert.equal(page.url(), amazonUrl);
    });
    await t.test('Amazon: passender Empfehlungstitel ersetzt keinen anderen primären Titel', async () => {
      body = amazonPage('<button>In den Einkaufswagen</button>', `<h1>${amazonTitle}</h1><button>In den Einkaufswagen</button>`, 'Anderer Bluetooth Lautsprecher');
      await gotoFixture(amazonUrl);
      await assertStatus(amazonSettings, 'unknown');
    });
  } finally { await browser.close(); }
});
