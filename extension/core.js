export const DEFAULT_URL = 'https://www.pokemoncenter.com/de-de/product/10-10438-110/pokemon-sammelkartenspiel-pokemon-center-top-trainer-box-mega-entwicklung-delta-herrschaft';

export function canonicalProductUrl(value) {
  const productUrl = String(value ?? '').trim();
  let url;
  try { url = new URL(productUrl); } catch { throw new Error('Bitte eine gültige Produkt-URL eintragen.'); }
  if (url.protocol !== 'https:' || url.hostname !== 'www.pokemoncenter.com' || url.port
      || url.username || url.password || !/^\/de-de\/product\/[^/]+\/[^/]+\/?$/.test(url.pathname)) {
    throw new Error('Bitte eine deutsche Produktseite von https://www.pokemoncenter.com/de-de/product/ verwenden.');
  }
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.href;
}

function normalizeProduct(input) {
  const productUrl = canonicalProductUrl(input.productUrl);
  const productTitle = String(input.productTitle ?? '').trim();
  if (productTitle.length < 2 || productTitle.length > 240) throw new Error('Bitte einen eindeutigen Teil des Produktnamens eintragen (2–240 Zeichen).');
  return { productUrl, productTitle };
}

export function normalizeSettings(input = {}, previous = {}) {
  let source;
  if (Object.hasOwn(input, 'products')) source = input.products;
  else if (Object.hasOwn(input, 'productUrl') || Object.hasOwn(input, 'productTitle')) {
    const first = previous.products?.[0] || previous;
    source = [{ productUrl: input.productUrl ?? first.productUrl ?? DEFAULT_URL, productTitle: input.productTitle ?? first.productTitle ?? 'Delta-Herrschaft' }, ...(previous.products?.slice(1) || [])];
  } else source = previous.products ?? [{ productUrl: previous.productUrl ?? DEFAULT_URL, productTitle: previous.productTitle ?? 'Delta-Herrschaft' }];
  if (!Array.isArray(source) || source.length < 1 || source.length > 10) throw new Error('Bitte zwischen 1 und 10 Produkte angeben.');
  const products = source.map(item => {
    if (!item || typeof item !== 'object') throw new Error('Jedes Produkt benötigt eine URL und einen Produktnamen.');
    return normalizeProduct(item);
  });
  if (new Set(products.map(product => product.productUrl)).size !== products.length) throw new Error('Jede Produktseite darf nur einmal vorkommen.');
  const minMinutes = Number(input.minMinutes ?? previous.minMinutes ?? 15);
  const maxMinutes = Number(input.maxMinutes ?? previous.maxMinutes ?? 30);
  if (![minMinutes, maxMinutes].every(value => Number.isFinite(value) && value >= 1 && value <= 1440 && Math.abs(value * 100 - Math.round(value * 100)) < 1e-8)
      || minMinutes > maxMinutes) throw new Error('Die Zeitspanne muss zwischen 1 und 1440 Minuten liegen (höchstens zwei Nachkommastellen); „Von“ darf „Bis“ nicht überschreiten.');
  const botToken = String(input.botToken || '').trim() || String(previous.botToken || '').trim();
  const chatId = String(input.chatId ?? previous.chatId ?? '').trim();
  if (chatId && !/^-?\d+$/.test(chatId) && !/^@[a-zA-Z0-9_]{5,}$/.test(chatId)) {
    throw new Error('Chat-ID muss eine Zahl oder ein Telegram-Kanalname mit @ sein.');
  }
  // Aliases allow existing single-product settings to migrate without losing data.
  return { products, minMinutes, maxMinutes, productUrl: products[0].productUrl, productTitle: products[0].productTitle, botToken, chatId };
}

export function chooseDelayMs(random = Math.random, minMinutes = 15, maxMinutes = 30) {
  const minimum = Math.round(minMinutes * 60000);
  const maximum = Math.round(maxMinutes * 60000);
  return minimum + Math.min(maximum - minimum, Math.max(0, Math.floor(random() * (maximum - minimum + 1))));
}

export function nextProduct(products, nextUrl, previousProducts = products) {
  const direct = products.find(product => product.productUrl === nextUrl);
  if (direct) return direct;
  const start = previousProducts.findIndex(product => product.productUrl === nextUrl);
  if (start >= 0) {
    for (let offset = 1; offset <= previousProducts.length; offset++) {
      const old = previousProducts[(start + offset) % previousProducts.length];
      const remaining = products.find(product => product.productUrl === old.productUrl);
      if (remaining) return remaining;
    }
  }
  return products[0];
}

export function shouldNotify(previous, url, status) {
  return status === 'available' && (previous?.url !== url || previous?.status !== 'available');
}

// Self-contained: Chrome serializes this function into an isolated page context.
// It receives only product details; Telegram credentials never enter a web page.
export function inspectProduct({ productUrl, productTitle }) {
  const unknown = reason => ({ status: 'unknown', reason });
  const target = new URL(productUrl);
  if (location.origin !== target.origin || location.pathname.replace(/\/+$/, '') !== target.pathname.replace(/\/+$/, '')) return unknown('Im Tab ist eine andere Seite geöffnet.');
  const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
  const visible = node => {
    const rect = node.getBoundingClientRect();
    if (!rect.width || !rect.height || node.closest('[hidden],[aria-hidden="true"]')) return false;
    if (node.checkVisibility) return node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    const style = getComputedStyle(node);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  };
  const headings = [...document.querySelectorAll('h1,[role="heading"][aria-level="1"]')].filter(visible);
  if (headings.length !== 1 || !normalize(headings[0].innerText).toLowerCase().includes(productTitle.toLowerCase())) {
    return unknown('Die erwartete Produktüberschrift fehlt. Möglicherweise lädt die Seite noch oder der Zugriff ist eingeschränkt.');
  }
  const mains = [...document.querySelectorAll('main,[role="main"]')].filter(node => node.contains(headings[0]));
  if (mains.length !== 1) return unknown('Der Produktbereich ist nicht eindeutig erkennbar.');
  const root = mains[0];
  const productSection = node => {
    const preceding = [...root.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')]
      .filter(heading => visible(heading) && (heading.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING));
    return preceding.at(-1) === headings[0];
  };
  const cartPattern = /^(?:in den warenkorb(?: legen)?|zum warenkorb hinzufügen|add to (?:cart|basket))$/i;
  const stockPattern = /^(?:momentan nicht verfügbar|derzeit nicht verfügbar|nicht verfügbar|ausverkauft|out of stock|unavailable)[.!]?$/i;
  const candidates = [...root.querySelectorAll('button,[role="button"],input[type="submit"],input[type="button"]')]
    .filter(node => visible(node) && cartPattern.test(normalize(node.getAttribute('aria-label') || node.innerText || node.value)));
  const stockText = [...root.querySelectorAll('button,[role="button"],p,span,div')]
    .some(node => stockPattern.test(normalize(node.innerText)) && visible(node) && productSection(node));
  if (candidates.length > 1) return unknown('Mehrere Warenkorb-Buttons gefunden; keine eindeutige Zuordnung.');
  if (!candidates.length) return stockText
    ? { status: 'unavailable', reason: 'Das Produkt wird als nicht verfügbar angezeigt.' }
    : unknown('Kein eindeutiger Warenkorb-Status gefunden.');
  const button = candidates[0];
  if (!productSection(button)) return unknown('Der Button könnte zu einer Produktempfehlung gehören.');
  if (button.matches(':disabled') || button.closest('[aria-disabled="true"],[inert]')) {
    return { status: 'unavailable', reason: 'Der Warenkorb-Button ist deaktiviert.' };
  }
  if (stockText) return unknown('Warenkorb-Button und Bestandsanzeige widersprechen sich.');
  const position = { x: window.scrollX, y: window.scrollY };
  try {
    button.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    const rect = button.getBoundingClientRect();
    const x = Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2));
    const y = Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2));
    const top = document.elementFromPoint(x, y);
    if (!top || !button.contains(top)) return unknown('Der Warenkorb-Button wird von einer Einblendung verdeckt.');
    return { status: 'available', reason: 'Ein sichtbarer, aktiver und nicht verdeckter Warenkorb-Button wurde erkannt.' };
  } finally { window.scrollTo({ left: position.x, top: position.y, behavior: 'instant' }); }
}
