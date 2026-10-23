import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';

test('Manifest verlangt festen Websitezugriff nur für Telegram und optionale Freigaben für Shops', async () => {
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.host_permissions, ['https://api.telegram.org/*']);
  assert.deepEqual(manifest.optional_host_permissions, ['https://*/*', 'http://*/*']);
});

test('Einstellungsseite schützt ungespeicherte Produkte, Speichervorgänge und laufende Prüfungen', async () => {
  const source = await readFile(new URL('../extension/options.js', import.meta.url), 'utf8');
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const elements = new Map();
  class Element {
    constructor(tagName = '') { this.tagName=tagName.toUpperCase();this.listeners={};this.dataset={};this.value='';this.children=[];this.attributes={};this.customError=''; }
    get options() { return this.children; }
    addEventListener(type,handler) { (this.listeners[type]??=[]).push(handler); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children=[...children]; }
    setAttribute(name,value) { this.attributes[name]=value; }
    removeAttribute(name) { delete this.attributes[name]; }
    setCustomValidity(value) { this.customError=value; }
    reportValidity() { return ![...elements.values()].some(item=>item.customError); }
    requestSubmit() { for(const handler of this.listeners.submit||[]) handler({preventDefault(){}}); }
    focus() {}
  }
  const element=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  let settings={products:[{productUrl:'https://shop.example/produkt/kopfhoerer',productTitle:'A'},{productUrl:'https://shop.example/produkt/lautsprecher',productTitle:'B'}],minMinutes:15,maxMinutes:30,chatId:'123',tokenConfigured:true};
  let enabled=false;
  let saveMode='success';let release;
  let permissionGranted=true;
  const permissionCalls=[];
  const calls=[];const windowListeners={};
  const context=vm.createContext({
    document:{getElementById:element,createElement:tag=>new Element(tag),addEventListener(){},hidden:false},
    window:{addEventListener(type,handler){windowListeners[type]=handler;}},
    chrome:{permissions:{request:details=>{
      permissionCalls.push(details);
      return Promise.resolve(permissionGranted);
    }},runtime:{sendMessage:async({type,payload})=>{
      calls.push({type,payload});
      if(type==='GET_STATUS')return{ok:true,data:{settings,monitor:{enabled,checking:false},log:[]}};
      if(type==='SAVE_SETTINGS'){
        if(saveMode==='fail')return{ok:false,error:'Speichern fehlgeschlagen'};
        if(saveMode==='deferred')await new Promise(resolve=>{release=resolve;});
        settings={...payload,botToken:undefined,tokenConfigured:true};return{ok:true,data:{}};
      }
      if(type==='STOP'){enabled=false;return{ok:true,data:{}};}
      if(type==='START'){enabled=true;return{ok:true,data:{}};}
      return{ok:true,data:{}};
    }}},setInterval(){},console,Date,URL,
  });
  vm.runInContext(source,context);await tick();
  const rows=()=>vm.runInContext('productRows',context);
  const changed=()=>element('settings-form').listeners.input[0]();
  const isDirty=()=>vm.runInContext('dirty',context);
  assert.equal(isDirty(),false);assert.equal(element('unsaved-status').hidden,true);
  assert.equal('buttonSelector' in vm.runInContext('readFormSettings()',context).products[0],false);
  assert.equal('buttonText' in vm.runInContext('readFormSettings()',context).products[0],false);
  for(const key of ['buttonSelector','buttonText']){
    const input=rows()[0][key];
    input.value=key==='buttonSelector'?'button[name="add"]':'Jetzt bestellen';changed();
    assert.equal(isDirty(),true,key);
    await context.refreshStatus();assert.ok(input.value,key);
    input.value='';changed();assert.equal(isDirty(),false,key);
  }
  assert.equal(rows()[0].buttonSelector.maxLength,512);
  assert.equal(rows()[0].buttonText.maxLength,240);
  rows()[0].productTitle.value='Edited';changed();
  assert.equal(isDirty(),true);assert.equal(element('start').disabled,true);assert.equal(element('check').disabled,true);
  element('start').listeners.click[0]();element('check').listeners.click[0]();
  assert.equal(calls.some(call=>['START','CHECK_NOW'].includes(call.type)),false);
  let prevented=false;windowListeners.beforeunload({preventDefault(){prevented=true;}});assert.equal(prevented,true);
  await context.refreshStatus();assert.equal(rows()[0].productTitle.value,'Edited');assert.equal(isDirty(),true);
  rows()[0].productTitle.value='A';changed();assert.equal(isDirty(),false);
  element('add-product').listeners.click[0]();assert.equal(isDirty(),true);rows()[2].remove.listeners.click[0]();assert.equal(isDirty(),false);
  rows()[0].down.listeners.click[0]();assert.equal(isDirty(),true);rows()[0].down.listeners.click[0]();assert.equal(isDirty(),false);
  for(const id of ['min-minutes','max-minutes','chat-id','bot-token']){
    const input=element(id);const before=input.value;input.value=id==='bot-token'?'new-secret':String(Number(before)+1);changed();assert.equal(isDirty(),true,id);input.value=before;changed();assert.equal(isDirty(),false,id);
  }
  rows()[0].productUrl.value+='-changed';changed();assert.equal(isDirty(),true);rows()[0].productUrl.value=settings.products[0].productUrl;changed();assert.equal(isDirty(),false);
  rows()[0].productTitle.value='Submitted';changed();saveMode='fail';element('save-from-status').listeners.click[0]();await tick();assert.equal(isDirty(),true);assert.equal(element('unsaved-status').hidden,false);
  saveMode='deferred';element('bot-token').value='submitted-token';changed();element('save-from-status').listeners.click[0]();await tick();
  rows()[0].productTitle.value='Later edit';element('bot-token').value='later-token';changed();release();await tick();
  assert.equal(isDirty(),true);assert.equal(element('bot-token').value,'later-token');assert.equal(rows()[0].productTitle.value,'Later edit');
  saveMode='success';element('save-from-status').listeners.click[0]();await tick();
  assert.equal(isDirty(),false);assert.equal(element('bot-token').value,'');assert.equal(element('unsaved-status').hidden,true);assert.equal(element('check').disabled,false);
  prevented=false;windowListeners.beforeunload({preventDefault(){prevented=true;}});assert.equal(prevented,false);
  enabled=true;await context.refreshStatus();rows()[0].productTitle.value='Dirty while running';changed();assert.equal(element('stop').disabled,false);
  await element('stop').listeners.click[0]();assert.ok(calls.some(call=>call.type==='STOP'));assert.equal(isDirty(),true);

  rows()[0].productTitle.value=settings.products[0].productTitle;
  rows()[0].buttonSelector.value='button[name="add"]';
  rows()[0].buttonText.value='Jetzt bestellen';changed();
  permissionGranted=false;
  const savedBeforeDenial=calls.filter(call=>call.type==='SAVE_SETTINGS').length;
  const requestedBeforeDenial=permissionCalls.length;
  element('save-from-status').listeners.click[0]();
  assert.equal(permissionCalls.length,requestedBeforeDenial+1,'Shop-Berechtigung wird synchron im Submit-Handler angefragt');
  assert.equal(calls.filter(call=>call.type==='SAVE_SETTINGS').length,savedBeforeDenial,'SAVE wartet auf die Berechtigung');
  await tick();
  assert.equal(calls.filter(call=>call.type==='SAVE_SETTINGS').length,savedBeforeDenial,'Abgelehnter Zugriff speichert keine Einstellungen');
  assert.equal(isDirty(),true);
  assert.match(element('notice').textContent,/nicht freigegeben/);
  assert.deepEqual(Array.from(permissionCalls.at(-1).origins),['https://shop.example/*']);
  permissionGranted=true;
  element('save-from-status').listeners.click[0]();await tick();
  assert.equal(settings.products[0].buttonSelector,'button[name="add"]');
  assert.equal(settings.products[0].buttonText,'Jetzt bestellen');
  assert.equal(isDirty(),false);
  rows()[0].buttonSelector.value='';rows()[0].buttonText.value='';changed();
  element('save-from-status').listeners.click[0]();await tick();
  assert.equal('buttonSelector' in settings.products[0],false);
  assert.equal('buttonText' in settings.products[0],false);
  assert.equal(isDirty(),false);

  rows()[0].productUrl.value='https://shop.example/products/a';
  rows()[1].productUrl.value='https://shop.example/products/b';
  element('add-product').listeners.click[0]();
  rows()[2].productUrl.value='http://another.example:8080/products/c';
  rows()[2].productTitle.value='Produkt C';changed();
  element('save-from-status').listeners.click[0]();await tick();
  assert.deepEqual(Array.from(permissionCalls.at(-1).origins),['https://shop.example/*','http://another.example/*'],'Nur eindeutige eingetragene Shops werden angefragt');
  assert.equal(settings.products[0].productUrl,'https://shop.example/products/a');
  assert.equal(settings.products[2].productUrl,'http://another.example:8080/products/c');
  assert.equal(isDirty(),false);
  const requestedBeforeCleanSave=permissionCalls.length;
  element('settings-form').requestSubmit();
  assert.equal(permissionCalls.length,requestedBeforeCleanSave+1,'Auch unveränderte Einstellungen können fehlenden Shop-Zugriff erneut anfragen');
  await tick();

  const requestedBeforeInvalid=permissionCalls.length;
  const savedBeforeInvalid=calls.filter(call=>call.type==='SAVE_SETTINGS').length;
  for(const address of ['https://user:fake-password@shop.example/product/a','file:///tmp/product','https://*/product','https://*.example.test/product']){
    rows()[0].productUrl.value=address;changed();
    element('save-from-status').listeners.click[0]();await tick();
    assert.equal(permissionCalls.length,requestedBeforeInvalid);
    assert.equal(calls.filter(call=>call.type==='SAVE_SETTINGS').length,savedBeforeInvalid);
    assert.equal(isDirty(),true);
    assert.match(element('notice').textContent,/HTTP- oder HTTPS-Adresse ohne Zugangsdaten/);
  }
  context.renderProductStatuses({products:[
    {productUrl:'http://shop.example/product/a',productTitle:'HTTP-Produkt'},
    {productUrl:'https://shop.example/product/b',productTitle:'HTTPS-Produkt'},
    {productUrl:'https://user:fake-password@shop.example/product/c',productTitle:'Kein sicherer Link'},
    {productUrl:'javascript:alert(1)',productTitle:'Kein Shop-Link'},
  ]});
  const renderedLinks=element('product-statuses').children.map(item=>item.children[0].children[0]);
  assert.deepEqual(renderedLinks.map(link=>link.tagName),['A','A','SPAN','SPAN']);
  context.renderProductStatuses({products:[
    {productUrl:'https://shop.example/product/a',productTitle:'Produkt A'},
    {productUrl:'https://shop.example/product/b',productTitle:'Produkt B'},
  ]},[
    {productUrl:'https://shop.example/product/a',status:'available',lastReason:'<img src=x onerror="alert(1)"> Sofort lieferbar'},
    {productUrl:'https://shop.example/product/b',status:'unknown',lastReason:'Dieser Hinweis muss bei Fehler verborgen bleiben',lastError:'Produktseite blockiert'},
  ]);
  const reasonItems=element('product-statuses').children;
  assert.equal(reasonItems[0].children[0].children[1].textContent,'Lieferbar');
  assert.equal(reasonItems[0].children.at(-1).textContent,'<img src=x onerror="alert(1)"> Sofort lieferbar','Lieferhinweise werden ausschließlich als Text ausgegeben');
  assert.equal(reasonItems[1].children.at(-1).textContent,'Produktseite blockiert');
  assert.equal(reasonItems[1].children.some(child=>child.textContent==='Dieser Hinweis muss bei Fehler verborgen bleiben'),false);

  settings.products=Array.from({length:12},(_,index)=>({
    productUrl:`https://shop.example/products/saved-${index}`,
    productTitle:`Gespeichertes Produkt ${index}`,
    ...(index===11?{buttonText:'Jetzt bestellen'}:{}),
  }));
  context.renderStatus({settings,monitor:{enabled:false,checking:false},log:[]},true);
  assert.equal(rows().length,12,'Alle gespeicherten Produkte werden ohne Kappung geladen');
  assert.equal(element('product-statuses').children.length,12,'Auch die Statusliste zeigt mehr als zehn Produkte');
  assert.equal(element('add-product').disabled,false);
  assert.equal(rows()[11].buttonText.value,'Jetzt bestellen');
  for(let index=12;index<15;index++){
    element('add-product').listeners.click[0]();
    rows()[index].productUrl.value=`https://shop.example/products/added-${index}`;
    rows()[index].productTitle.value=`Neues Produkt ${index}`;
  }
  changed();
  assert.equal(rows().length,15,'Weitere Produkte bleiben auch oberhalb von zehn hinzufügbar');
  assert.equal(element('add-product').disabled,false);
  rows()[12].up.listeners.click[0]();
  rows()[11].up.listeners.click[0]();
  const expectedOrder=Array.from(rows(),row=>row.productUrl.value);
  element('save-from-status').listeners.click[0]();await tick();
  assert.equal(settings.products.length,15);
  assert.deepEqual(Array.from(settings.products,product=>product.productUrl),expectedOrder,'Speichern erhält alle Produkte in der geänderten Reihenfolge');
  assert.equal(element('product-statuses').children.length,15);
  assert.equal(element('product-count').textContent,'15 Produkte');
  assert.equal(isDirty(),false);
  rows()[3].remove.listeners.click[0]();
  const afterRemoval=Array.from(rows(),row=>row.productUrl.value);
  element('save-from-status').listeners.click[0]();await tick();
  assert.equal(settings.products.length,14);
  assert.deepEqual(Array.from(settings.products,product=>product.productUrl),afterRemoval,'Entfernen oberhalb der alten Grenze verliert keine übrigen Produkte');
  assert.equal(element('add-product').disabled,false);
  const markup=await readFile(new URL('../extension/options.html',import.meta.url),'utf8');
  assert.match(markup,/<title>IchWillNixVerpassen<\/title>/);
  assert.match(markup,/<h1>IchWillNixVerpassen<\/h1>/);
});
