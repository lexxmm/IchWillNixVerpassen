export const DEFAULT_URL = 'https://shop.example/produkt/kopfhoerer';

export function canonicalProductUrl(value) {
  const productUrl = String(value ?? '').trim();
  if (productUrl.length > 2048) throw new Error('Die Produkt-URL darf höchstens 2048 Zeichen enthalten.');
  let url;
  try { url = new URL(productUrl); } catch { throw new Error('Bitte eine gültige Produkt-URL eintragen.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hostname.includes('*')) {
    throw new Error('Bitte eine HTTP- oder HTTPS-Produktseite ohne Benutzername und Passwort verwenden.');
  }
  // Shops may encode product variants in query strings or fragments.
  if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '');
  if (url.href.length > 2048) throw new Error('Die Produkt-URL darf höchstens 2048 Zeichen enthalten.');
  return url.href;
}

export function sameProductUrl(first, second) {
  try { return canonicalProductUrl(first) === canonicalProductUrl(second); }
  catch { return false; }
}

export function sitePermissionPattern(value) {
  const url = new URL(canonicalProductUrl(value));
  // Chrome match patterns do not include port numbers.
  return `${url.protocol}//${url.hostname}/*`;
}

function normalizeProduct(input) {
  const productUrl = canonicalProductUrl(input.productUrl);
  const productTitle = String(input.productTitle ?? '').trim();
  if (productTitle.length < 2 || productTitle.length > 240) throw new Error('Bitte einen eindeutigen Teil des Produktnamens eintragen (2–240 Zeichen).');
  const product = { productUrl, productTitle };
  for (const [field, maxLength, label] of [
    ['buttonSelector', 512, 'CSS-Auswahl'],
    ['buttonText', 240, 'Buttontext'],
  ]) {
    const value = input[field] ?? '';
    if (typeof value !== 'string') throw new Error(`${label} muss ein Text sein.`);
    const normalized = value.trim();
    if (normalized.length > maxLength) throw new Error(`${label} darf höchstens ${maxLength} Zeichen enthalten.`);
    if (normalized) product[field] = normalized;
  }
  return product;
}

export function normalizeSettings(input = {}, previous = {}) {
  let source;
  if (Object.hasOwn(input, 'products')) source = input.products;
  else if (Object.hasOwn(input, 'productUrl') || Object.hasOwn(input, 'productTitle')) {
    const first = previous.products?.[0] || previous;
    source = [{
      productUrl: input.productUrl ?? first.productUrl ?? DEFAULT_URL,
      productTitle: input.productTitle ?? first.productTitle ?? 'Kabellose Kopfhörer',
      buttonSelector: input.buttonSelector ?? first.buttonSelector,
      buttonText: input.buttonText ?? first.buttonText,
    }, ...(previous.products?.slice(1) || [])];
  } else source = previous.products ?? [{ productUrl: previous.productUrl ?? DEFAULT_URL, productTitle: previous.productTitle ?? 'Kabellose Kopfhörer' }];
  if (!Array.isArray(source) || source.length < 1) throw new Error('Bitte mindestens ein Produkt angeben.');
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
export function inspectProduct({ productUrl, productTitle, buttonSelector = '', buttonText = '' }) {
  const unknown = reason => ({ status: 'unknown', reason });
  // Duplicate the small canonicalizer deliberately: executeScript serializes this
  // function without its imports or module scope.
  const canonical = value => {
    const url = new URL(String(value).trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hostname.includes('*')) throw new Error('URL');
    if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '');
    return url.href;
  };
  try {
    if (canonical(location.href) !== canonical(productUrl)) return unknown('Im Tab ist eine andere Seite oder Produktvariante geöffnet.');
  } catch { return unknown('Die Produkt-URL ist ungültig.'); }
  const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
  const visible = node => {
    const rect = node.getBoundingClientRect();
    if (!rect.width || !rect.height || node.closest('[hidden],[aria-hidden="true"]')) return false;
    if (node.checkVisibility) return node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    const style = getComputedStyle(node);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  };
  const expectedTitle = normalize(productTitle).toLowerCase();
  if (/(?:der zugriff ist vorübergehend eingeschränkt|access denied|request unsuccessful|verify (?:that )?you are human|bestätigen sie, dass sie ein mensch)/i.test(document.body?.innerText || '')) {
    return unknown('Die Seite zeigt eine Zugriffs- oder Sicherheitsprüfung statt eines bestätigten Lieferstatus.');
  }
  const allMains = [...document.querySelectorAll('main,[role="main"]')];
  const inMain = node => !allMains.length || allMains.some(main => main.contains(node));
  const recommendationSelector = '#epoq_recommended,.epoq-recommendations-widget,.recommendations,.related-products,.product-recommendations,.recommended-products,[data-recommendation],[data-recommendations],[id^="sims-"],[id^="sims_"],[id*="recommendations"],[data-feature-name^="sims"],[data-feature-name*="recommendation"],[data-a-carousel-options]';
  const schemaSelector = '[itemtype~="https://schema.org/Product"],[itemtype~="http://schema.org/Product"]';
  const h1s = [...document.querySelectorAll('h1,[role="heading"][aria-level="1"]')].filter(node => visible(node) && inMain(node));
  // Some shops mark the actual product name as h2[itemprop=name] and reserve h1
  // for the later description. Prefer the first semantic product heading, never
  // a later recommendation merely because its text happens to match the title.
  const semanticNames = [...document.querySelectorAll('h1[itemprop~="name"],h2[itemprop~="name"],h3[itemprop~="name"],h4[itemprop~="name"],h5[itemprop~="name"],h6[itemprop~="name"],[role="heading"][itemprop~="name"]')]
    .filter(node => visible(node) && inMain(node));
  let heading;
  let semantic = false;
  // A primary product landmark disambiguates pages such as Amazon, whose extra
  // h1s are navigation/accessibility/info headings. Never select a merely matching
  // arbitrary h1 or a duplicate hidden input that happens to share productTitle.
  const landmarkHeadings = [...new Set([...document.querySelectorAll('#productTitle')]
    .filter(node => visible(node) && inMain(node) && !node.closest(recommendationSelector))
    .filter(node => node.closest(`#ppd,#dp-container,#product-top,[data-product-details],.product-details,${schemaSelector}`))
    .map(node => node.closest('h1,h2,h3,h4,h5,h6,[role="heading"]')).filter(Boolean))];
  if (landmarkHeadings.length) {
    if (landmarkHeadings.length === 1 && normalize(landmarkHeadings[0].innerText).toLowerCase().includes(expectedTitle)) heading = landmarkHeadings[0];
  } else if (semanticNames.length) {
    const first = semanticNames[0];
    const matching = semanticNames.filter(node => normalize(node.innerText).toLowerCase().includes(expectedTitle));
    const earlierOtherH1 = h1s.some(node => node !== first && (node.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING));
    if (expectedTitle && matching.length === 1 && matching[0] === first && !earlierOtherH1) {
      heading = first;
      semantic = true;
    } else if (h1s.length === 1 && normalize(h1s[0].innerText).toLowerCase().includes(expectedTitle)
      && (h1s[0].compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING)) heading = h1s[0];
  } else if (h1s.length === 1 && normalize(h1s[0].innerText).toLowerCase().includes(expectedTitle)) heading = h1s[0];
  if (!expectedTitle || !heading) {
    return unknown('Die erwartete Produktüberschrift fehlt. Möglicherweise lädt die Seite noch oder der Zugriff ist eingeschränkt.');
  }
  const mains = allMains.filter(node => node.contains(heading));
  if (allMains.length && mains.length !== 1) return unknown('Der Produktbereich ist nicht eindeutig erkennbar.');
  const semanticContainer = heading.closest(`#ppd,#product-top,.product-details,[data-product-details],form[id*="buy"],${schemaSelector}`);
  const productContainer = semanticContainer && (!mains[0] || mains[0].contains(semanticContainer)) ? semanticContainer : null;
  const root = productContainer || mains[0] || heading.closest(`article,section,[data-product],${schemaSelector}`) || document.body;
  if (!root) return unknown('Der Produktbereich ist nicht erkennbar.');
  // A class such as .product-details can be only the title box. Fallback metadata
  // must also respect blocking controls in the surrounding semantic product.
  const guardRoot = heading.closest(schemaSelector) || mains[0] || root;
  const outsideProduct = node => {
    const recommendation = node.closest(recommendationSelector);
    if (recommendation && !recommendation.contains(heading)) return true;
    const navigation = node.closest('header,footer,nav,aside,[role="banner"],[role="navigation"],[role="contentinfo"],[role="complementary"]');
    return navigation && !navigation.contains(heading);
  };
  const primaryBuybox = node => {
    const box = node.closest('#buybox,#desktop_buybox');
    return Boolean(productContainer?.matches('#ppd') && box && productContainer.contains(box) && !box.closest(recommendationSelector));
  };
  const precedingHeadings = node => [...root.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')]
    .filter(other => visible(other) && (other.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING));
  const foreignSection = node => {
    if (outsideProduct(node)) return true;
    const schema = node.closest(schemaSelector);
    if (schema && schema !== heading.closest(schemaSelector)) return true;
    // Amazon renders the right-column buybox before its center-column title in
    // DOM order; their shared #ppd landmark establishes the product association.
    if (primaryBuybox(node)) return false;
    const preceding = precedingHeadings(node);
    const titleIndex = preceding.indexOf(heading);
    const afterTitle = titleIndex < 0 ? preceding : preceding.slice(titleIndex + 1);
    return afterTitle.some(other => other.matches('[itemprop~="name"]')
      || /(?:empfehlungen|ähnliche produkte|weitere produkte|andere produkte|kunden kauften|related products|recommended|you may also like)/i.test(normalize(other.innerText)));
  };
  const productSection = node => {
    if (foreignSection(node)) return false;
    if (primaryBuybox(node)) return true;
    const preceding = precedingHeadings(node);
    if (!productContainer) return preceding.at(-1) === heading;
    if (!(heading.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
    // In a semantically scoped product, headings such as Inhalt/Lieferung are
    // ordinary details. Explicit recommendation sections and other named
    // products still exclude their controls and stock labels.
    return true;
  };
  const sameUrl = value => {
    try { return canonical(new URL(String(value), location.href).href) === canonical(productUrl); }
    catch { return false; }
  };
  const targetVariant = new URL(canonical(productUrl));
  const requiresVariantUrl = Boolean(targetVariant.search || targetVariant.hash);
  const hasVariantControls = [...guardRoot.querySelectorAll('select,input[type="radio"],[role="combobox"]')]
    .some(node => visible(node) && !foreignSection(node));
  const headingName = normalize(heading.innerText).toLowerCase();
  const matchesName = value => {
    const name = normalize(value).toLowerCase();
    return name.includes(expectedTitle) && (name.includes(headingName) || headingName.includes(name));
  };
  const hasType = (value, type) => (Array.isArray(value) ? value : [value]).some(item => item === type || item === `https://schema.org/${type}` || item === `http://schema.org/${type}`);
  const availabilitySignal = value => {
    const text = typeof value === 'object' && value ? value['@id'] : value;
    const name = String(text || '').replace(/^https?:\/\/schema\.org\//, '');
    if (name === 'InStock') return { status: 'available', reason: 'Strukturierte Angebotsdaten melden InStock für dieses Produkt.' };
    if (['OutOfStock', 'SoldOut', 'Discontinued'].includes(name)) return { status: 'unavailable', reason: 'Strukturierte Angebotsdaten melden das Produkt als nicht lieferbar.' };
    if (['PreOrder', 'PreSale', 'BackOrder'].includes(name)) return unknown('Vorbestellung oder Nachbestellung bestätigt keine aktuelle Lieferbarkeit.');
    return null;
  };
  const offerSignal = (name, url, offers) => {
    if (!matchesName(name) || (url !== undefined && url !== null && !sameUrl(url))) return null;
    const list = Array.isArray(offers) ? offers : offers ? [offers] : [];
    if (!list.length) return null;
    if (list.length !== 1) return unknown('Mehrere strukturierte Angebote sind nicht eindeutig einem lieferbaren Produkt zuzuordnen.');
    const offer = list[0];
    if (!offer || !hasType(offer['@type'], 'Offer')) return null;
    if (offer.url !== undefined && !sameUrl(offer.url)) return null;
    if (offer.itemOffered && (typeof offer.itemOffered !== 'object' || (!offer.itemOffered.name && !offer.itemOffered.url)
        || (offer.itemOffered.name && normalize(offer.itemOffered.name).toLowerCase() !== normalize(name).toLowerCase())
        || (offer.itemOffered.url && !sameUrl(offer.itemOffered.url)))) return unknown('Das strukturierte Angebot benennt ein anderes Produkt.');
    if (requiresVariantUrl && !url && !offer.url) return null;
    return availabilitySignal(offer.availability);
  };
  const structuredSignals = [];
  const nodes = [];
  const collect = value => {
    if (Array.isArray(value)) { for (const item of value) collect(item); }
    else if (value && typeof value === 'object') {
      nodes.push(value);
      if (Array.isArray(value['@graph'])) for (const item of value['@graph']) collect(item);
    }
  };
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    if (script.textContent.length > 250000) continue;
    try { collect(JSON.parse(script.textContent)); } catch { /* Invalid shop metadata is never a positive signal. */ }
  }
  const byId = new Map(nodes.filter(node => typeof node['@id'] === 'string').map(node => [node['@id'], node]));
  const jsonProducts = nodes.filter(node => hasType(node['@type'], 'Product') && matchesName(node.name)
    && (node.url === undefined || sameUrl(node.url)));
  if (!hasVariantControls && jsonProducts.length > 1) structuredSignals.push(unknown('Mehrere strukturierte Produkte passen zur Seite; Lieferbarkeit ist nicht eindeutig.'));
  else if (!hasVariantControls && jsonProducts.length === 1) {
    const product = jsonProducts[0];
    const resolve = value => value?.['@id'] && !value['@type'] ? byId.get(value['@id']) || value : value;
    const offers = Array.isArray(product.offers) ? product.offers.map(resolve) : resolve(product.offers);
    const signal = offerSignal(product.name, product.url, offers);
    if (signal) structuredSignals.push(signal);
  }
  const microProduct = heading.closest(schemaSelector);
  if (microProduct && !hasVariantControls) {
    const offerSelector = '[itemtype~="https://schema.org/Offer"],[itemtype~="http://schema.org/Offer"]';
    const value = node => node.getAttribute('content') || node.getAttribute('href') || normalize(node.innerText);
    const ownValues = (parent, property, ownOffer = null) => [...parent.querySelectorAll(`[itemprop~="${property}"]`)]
      .filter(node => node.closest(schemaSelector) === microProduct && node.closest(offerSelector) === ownOffer)
      .map(value).filter(Boolean);
    const names = [...new Set(ownValues(microProduct, 'name'))];
    const urls = [...new Set(ownValues(microProduct, 'url'))];
    const offers = [...microProduct.querySelectorAll('[itemprop~="offers"]')]
      .filter(node => node.matches(offerSelector) && node.closest(schemaSelector) === microProduct);
    if (names.length === 1 && matchesName(names[0]) && urls.length > 1) structuredSignals.push(unknown('Die strukturierten Produkt-URLs sind nicht eindeutig.'));
    else if (names.length === 1 && urls.length <= 1 && matchesName(names[0])) {
      let conflictingOffer = false;
      const data = offers.map(offer => {
        const stock = [...new Set(ownValues(offer, 'availability', offer))];
        const offerUrls = [...new Set(ownValues(offer, 'url', offer))];
        if (stock.length > 1 || offerUrls.length > 1) conflictingOffer = true;
        return { '@type': 'Offer', ...(offerUrls.length === 1 ? { url: offerUrls[0] } : {}), availability: stock.length === 1 ? stock[0] : '' };
      });
      const signal = conflictingOffer ? unknown('Die strukturierten Angebotsdaten widersprechen sich.') : offerSignal(names[0], urls[0], data);
      if (signal) structuredSignals.push(signal);
    }
  }
  const schemaNegative = structuredSignals.some(signal => signal.status === 'unavailable');
  const schemaPositive = structuredSignals.some(signal => signal.status === 'available');
  const schemaUnclear = structuredSignals.find(signal => signal.status === 'unknown');
  const cartPattern = /^(?:in den (?:warenkorb|einkaufswagen)(?: legen| hinzufügen)?|zum warenkorb(?: hinzufügen)?|jetzt (?:kaufen|bestellen)|sofort kaufen|add to (?:cart|basket)|add (?:item|product) to (?:cart|basket)|buy now|ajouter au panier|aggiungi al carrello|añadir al carrito|in winkelwagen)$/i;
  const stockPattern = /^(?:(?:(?:momentan|derzeit|zurzeit|aktuell) )?nicht (?:verfügbar|lieferbar|auf lager|vorrätig|erhältlich|kaufbar)|(?:der )?artikel kann (?:derzeit|aktuell|zurzeit|momentan) nicht gekauft werden|auf einladung erhältlich|available (?:by|on) invitation(?: only)?|invitation only|ausverkauft|out of stock|sold out|(?:currently |temporarily )?unavailable|(?:currently )?not available|not in stock)[.!]?$/i;
  const uncertainStockPattern = /^(?:liefertermin unbekannt|lieferdatum unbekannt|delivery date unknown)[.!]?$/i;
  const notPurchasePattern = /^(?:(?:eine )?einladung (?:anfragen|anfordern|beantragen)|request (?:an )?(?:invitation|invite)|invite me|notify me(?: when available)?|benachrichtigen(?: sie mich)?|informiere mich(?:\s*\.\.\.)?)[.!]?$/i;
  const stockOnlyPattern = /^(?:auf lager|verfügbar|lieferbar|vorrätig|in stock|available)[.!]?$/i;
  const positiveStockPattern = /^(?:auf lager|sofort lieferbar|sofort verfügbar|vorrätig|lagernd|in stock|available now|ready to ship)[.!]?$/i;
  const futureStockPattern = /^(?:vorbestell(?:bar|en)|jetzt vorbestellen|pre[- ]?order(?: now)?|backorder|lieferbar ab\b|verfügbar ab\b)/i;
  const visibleText = node => normalize(node.matches('input') ? node.value : node.innerText);
  const selector = normalize(buttonSelector);
  const wantedText = normalize(buttonText);
  const automaticControls = 'button,[role="button"],input[type="submit"],input[type="button"],a[href],[role="link"]';
  const disabled = node => node.matches(':disabled') || node.closest('[disabled],[aria-disabled="true" i],[inert],.disabled,.is-disabled') || getComputedStyle(node).pointerEvents === 'none';
  const unobstructed = node => {
    const position = { x: window.scrollX, y: window.scrollY };
    try {
      node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      const rect = node.getBoundingClientRect();
      const x = Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2));
      const y = Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2));
      const top = document.elementFromPoint(x, y);
      return Boolean(top && node.contains(top));
    } finally { window.scrollTo({ left: position.x, top: position.y, behavior: 'instant' }); }
  };
  const statusNodes = [...root.querySelectorAll('button,[role="button"],p,span,div,output')]
    .filter(node => visible(node) && productSection(node));
  const negativeNodes = statusNodes.filter(node => stockPattern.test(normalize(node.innerText)));
  const stockText = negativeNodes.length > 0;
  const uncertainText = statusNodes.some(node => uncertainStockPattern.test(normalize(node.innerText)));
  const unavailableReason = negativeNodes.some(node => /einladung|invitation/i.test(normalize(node.innerText)))
    ? 'Nicht kaufbar: Das Produkt ist nur auf Einladung erhältlich.'
    : negativeNodes.some(node => /nicht gekauft werden/i.test(normalize(node.innerText)))
      ? 'Der Shop meldet, dass der Artikel derzeit nicht gekauft werden kann.'
      : 'Das Produkt wird als nicht lieferbar angezeigt.';
  const futureText = statusNodes.some(node => futureStockPattern.test(normalize(node.innerText)) && normalize(node.innerText).length <= 160);
  const positiveNodes = statusNodes.filter(node => positiveStockPattern.test(normalize(node.innerText))
    && !node.closest(automaticControls));
  const positiveText = positiveNodes.length > 0;
  const variantMissing = [...guardRoot.querySelectorAll('select,input[type="radio"],[aria-required="true"]')].some(node => {
    if (!visible(node) || foreignSection(node)) return false;
    if (node.matches('select')) return !node.value && (node.required || node.selectedOptions[0]?.disabled || node.options[0]?.value === '');
    if (node.matches('input[type="radio"]') && node.required && node.name) {
      return ![...guardRoot.querySelectorAll('input[type="radio"]')].some(other => other.name === node.name && other.checked);
    }
    return node.getAttribute('aria-invalid') === 'true';
  }) || statusNodes.some(node => /^(?:bitte (?:eine )?(?:größe|grösse|variante|option) (?:wählen|auswählen)|(?:please )?(?:choose|select) (?:a |an )?(?:size|variant|option))[.!]?$/i.test(normalize(node.innerText)));
  let candidates;
  let ambiguousControl = false;
  if (selector) {
    try { candidates = [...root.querySelectorAll(buttonSelector)].filter(visible); }
    catch { return unknown('Die CSS-Auswahl für den Warenkorb-Button ist ungültig.'); }
    if (candidates.length !== 1) return unknown('Die CSS-Auswahl muss genau ein sichtbares Element im Produktbereich treffen.');
    if (foreignSection(candidates[0])) return unknown('Die CSS-Auswahl liegt in einem anderen Produkt- oder Empfehlungsbereich.');
    if (wantedText && visibleText(candidates[0]) !== wantedText) return unknown('Der sichtbare Buttontext stimmt nicht mit der Einstellung überein.');
    const chosen = candidates[0];
    const actionable = chosen.matches(`${automaticControls},a[href],[role="link"],[onclick]`) || chosen.tabIndex >= 0;
    if (!actionable) return unknown('Die CSS-Auswahl trifft kein erkennbares Bedienelement.');
  } else {
    const matching = [...root.querySelectorAll(automaticControls)].filter(node => visible(node)
      && (wantedText ? visibleText(node) === wantedText : cartPattern.test(visibleText(node) || normalize(node.getAttribute('aria-label')))));
    ambiguousControl = matching.some(node => !foreignSection(node) && !productSection(node));
    candidates = matching.filter(productSection);
  }
  if (!selector && !wantedText && candidates.length === 2) {
    const cart = candidates.filter(node => /^(?:in den (?:warenkorb|einkaufswagen)(?: legen| hinzufügen)?|zum warenkorb(?: hinzufügen)?|add to (?:cart|basket))$/i.test(visibleText(node) || normalize(node.getAttribute('aria-label'))));
    const immediate = candidates.filter(node => /^(?:buy now|jetzt kaufen|sofort kaufen)$/i.test(visibleText(node) || normalize(node.getAttribute('aria-label'))));
    const purchaseBox = node => node.closest('#buybox,[data-buybox],.buybox,.product-actions,[data-product-actions]') || node.closest('form');
    if (cart.length === 1 && immediate.length === 1 && !disabled(immediate[0])
        && purchaseBox(cart[0]) && purchaseBox(cart[0]) === purchaseBox(immediate[0])) candidates = cart;
  }
  if (candidates.length > 1) return unknown('Mehrere Warenkorb-Buttons gefunden; keine eindeutige Zuordnung.');
  if (!candidates.length) {
    if (selector || wantedText) return unknown('Der konfigurierte Warenkorb-Button wurde nicht gefunden.');
    if (ambiguousControl) return unknown('Eine mögliche Warenkorb-Aktion ist keiner eindeutigen Produktsektion zuzuordnen.');
    if (stockText || schemaNegative) return positiveText || schemaPositive
      ? unknown('Die Lieferstatusangaben widersprechen sich.')
      : { status: 'unavailable', reason: stockText ? unavailableReason : 'Das Produkt wird als nicht lieferbar angezeigt.' };
    if (uncertainText) return unknown('Der Liefertermin ist unbekannt.');
    if (futureText || variantMissing) return unknown('Vorbestellung oder eine noch fehlende Variantenauswahl bestätigt keine aktuelle Lieferbarkeit.');
    if (schemaUnclear) return schemaUnclear;
    if ([...root.querySelectorAll(automaticControls)].some(node => visible(node) && productSection(node) && notPurchasePattern.test(visibleText(node)))) {
      return unknown('Eine Einladungs- oder Benachrichtigungsanfrage bestätigt keine frei verfügbare Kaufaktion.');
    }
    if ([...guardRoot.querySelectorAll(automaticControls)].some(node => visible(node) && !foreignSection(node) && disabled(node))) return unknown('Ein Bedienelement im Produktbereich ist deaktiviert.');
    if (guardRoot !== root && [...guardRoot.querySelectorAll('p,span,div')].some(node => !root.contains(node) && visible(node) && !foreignSection(node)
        && (stockPattern.test(normalize(node.innerText)) || futureStockPattern.test(normalize(node.innerText))))) return unknown('Außerhalb des engen Produktbereichs wird ein widersprüchlicher Lieferstatus angezeigt.');
    if ([...document.querySelectorAll('dialog[open],[aria-modal="true"],[role="dialog"]')].some(visible)) return unknown('Eine Einblendung verhindert eine eindeutige Lieferprüfung.');
    if (positiveText) return positiveNodes.some(unobstructed)
      ? { status: 'available', reason: 'Ein eindeutiger sichtbarer Lieferstatus bestätigt die aktuelle Lieferbarkeit.' }
      : unknown('Die Lieferstatusanzeige wird von einer Einblendung verdeckt.');
    if (schemaPositive) return unobstructed(heading)
      ? { status: 'available', reason: 'Eindeutige strukturierte Angebotsdaten melden InStock für dieses Produkt.' }
      : unknown('Eine Einblendung verdeckt den Produktbereich.');
    return unknown('Kein eindeutiger Warenkorb- oder Lieferstatus gefunden.');
  }
  const button = candidates[0];
  if (!selector && !productSection(button)) return unknown('Der Button könnte zu einer Produktempfehlung gehören.');
  if (disabled(button) || stockPattern.test(visibleText(button))) {
    return { status: 'unavailable', reason: 'Der Warenkorb-Button ist deaktiviert.' };
  }
  if (notPurchasePattern.test(visibleText(button))) return unknown('Eine Einladungs- oder Benachrichtigungsanfrage ist keine frei verfügbare Kaufaktion.');
  if (stockOnlyPattern.test(visibleText(button))) return unknown('Eine Bestandsangabe allein bestätigt keinen Warenkorb-Button.');
  if (stockText || schemaNegative) return unknown('Warenkorb-Button und Bestandsanzeige widersprechen sich.');
  if (futureText || uncertainText || variantMissing || schemaUnclear || futureStockPattern.test(visibleText(button))) return unknown('Vorbestellung, Liefertermin, Angebotsdaten oder Variantenauswahl erlauben keine eindeutige Lieferprüfung.');
  if (!unobstructed(button)) return unknown('Der Warenkorb-Button wird von einer Einblendung verdeckt.');
  return { status: 'available', reason: 'Ein sichtbarer, aktiver und nicht verdeckter Warenkorb-Button wurde erkannt.' };
}
