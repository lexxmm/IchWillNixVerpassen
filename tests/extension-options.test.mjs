import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';

test('Einstellungsseite schützt ungespeicherte Produkte, Speichervorgänge und laufende Prüfungen', async () => {
  const source = await readFile(new URL('../extension/options.js', import.meta.url), 'utf8');
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const elements = new Map();
  class Element {
    constructor() { this.listeners={};this.dataset={};this.value='';this.children=[];this.attributes={};this.customError=''; }
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
  let settings={products:[{productUrl:'https://www.pokemoncenter.com/de-de/product/A',productTitle:'A'},{productUrl:'https://www.pokemoncenter.com/de-de/product/B',productTitle:'B'}],minMinutes:15,maxMinutes:30,chatId:'123',tokenConfigured:true};
  let enabled=false;
  let saveMode='success';let release;
  const calls=[];const windowListeners={};
  const context=vm.createContext({
    document:{getElementById:element,createElement:()=>new Element(),addEventListener(){},hidden:false},
    window:{addEventListener(type,handler){windowListeners[type]=handler;}},
    chrome:{runtime:{sendMessage:async({type,payload})=>{
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
});
