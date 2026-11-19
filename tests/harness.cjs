/* Deterministic DOM input and real Canvas pixels. CSS layout, audio quality,
 * real touch hardware and battery consumption require a browser/device check. */
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { createCanvas, ImageData, Path2D } = require('@napi-rs/canvas');

// One hub represents one origin. Writes are visible immediately; notifications
// use a later task, as in a browser. Set autoFlush:false to control event races
// with hub.flush(), or delayMs to postpone automatic delivery.
function createStorageHub(initialStorage = {}, {autoFlush = true, delayMs = 0, locks = true} = {}) {
  if (!Number.isFinite(delayMs) || delayMs < 0) throw new TypeError('delayMs must be non-negative');
  const values = new Map(Object.entries(initialStorage).map(([key, value]) => [String(key), String(value)]));
  const clients = new Set();
  const lockResources = new Map();
  let origin = null, queue = [], timer = null;
  const cancelTimer = () => { if (timer !== null) clearTimeout(timer); timer = null; };
  const schedule = () => {
    if (!autoFlush || !queue.length || timer !== null) return;
    timer = setTimeout(() => { timer = null; flush(); }, delayMs);
  };
  const enqueue = (source, key, oldValue, newValue) => {
    for (const recipient of clients) {
      if (recipient !== source) queue.push({recipient, key, oldValue, newValue, url:source.window.location.href});
    }
    schedule();
  };
  function flush(limit = Infinity) {
    if (limit !== Infinity && (!Number.isInteger(limit) || limit < 0)) throw new TypeError('limit must be a non-negative integer');
    cancelTimer();
    // A listener may make another write. Its event belongs to the next task.
    const batch = queue.splice(0, limit);
    let delivered = 0;
    for (const {recipient, ...details} of batch) {
      if (!clients.has(recipient)) continue;
      recipient.window.dispatchEvent(new recipient.window.StorageEvent('storage', {...details, storageArea:recipient.storage}));
      delivered++;
    }
    schedule();
    return delivered;
  }
  // The game uses held exclusive locks. Model the request queue and callback
  // promise lifecycle; storage delivery can remain paused independently.
  function finishLock(request, value, rejected = false, abandoned = false) {
    if (request.done) return;
    request.done = true;
    request.signal?.removeEventListener('abort', request.abort);
    request.client.requests.delete(request);
    const resource = request.resource;
    resource.queue = resource.queue.filter(item => item !== request);
    if (resource.holder === request) resource.holder = null;
    queueMicrotask(() => grantNext(resource));
    if (!abandoned) {
      if (rejected) request.reject(value);
      else request.resolve(value);
    }
  }
  function invokeLock(request, lock) {
    request.started = true;
    request.signal?.removeEventListener('abort', request.abort);
    try {
      Promise.resolve(request.callback(lock)).then(
        value => finishLock(request, value),
        error => finishLock(request, error, true)
      );
    } catch (error) { finishLock(request, error, true); }
  }
  function grantNext(resource) {
    if (resource.holder) return;
    while (resource.queue.length) {
      const request = resource.queue.shift();
      if (request.done) continue;
      resource.holder = request;
      invokeLock(request, Object.freeze({name:request.name, mode:'exclusive'}));
      break;
    }
  }
  function lockManager(client) {
    const window = client.window;
    return {request(name, options, callback) {
      if (typeof options === 'function') { callback = options; options = {}; }
      options ||= {};
      const invalid = message => Promise.reject(new window.DOMException(message, 'NotSupportedError'));
      if (typeof callback !== 'function') return Promise.reject(new window.TypeError('A lock callback is required'));
      name = String(name);
      if (name.startsWith('-')) return invalid('Lock names starting with a hyphen are reserved');
      if ((options.mode || 'exclusive') !== 'exclusive' || options.steal) return invalid('The harness supports exclusive locks without steal');
      if (options.signal && options.ifAvailable) return invalid('signal cannot be combined with ifAvailable');
      if (options.signal?.aborted) return Promise.reject(options.signal.reason);
      if (!clients.has(client)) return Promise.reject(new window.DOMException('Window is closed', 'InvalidStateError'));
      if (!lockResources.has(name)) lockResources.set(name, {holder:null, queue:[]});
      const request = {client, name, callback, signal:options.signal, resource:lockResources.get(name), done:false, started:false};
      request.promise = new Promise((resolve, reject) => {request.resolve=resolve;request.reject=reject;});
      request.abort = () => { if (!request.started) finishLock(request, request.signal.reason, true); };
      request.signal?.addEventListener('abort', request.abort, {once:true});
      client.requests.add(request);
      queueMicrotask(() => {
        if (request.done) return;
        const resource = request.resource;
        if (options.ifAvailable && (resource.holder || resource.queue.length)) invokeLock(request, null);
        else { resource.queue.push(request); grantNext(resource); }
      });
      return request.promise;
    }};
  }
  function connect(window) {
    if (origin !== null && window.location.origin !== origin) throw new TypeError('Storage hub windows must share an origin');
    if ([...clients].some(client => client.window === window)) throw new TypeError('Window is already connected');
    origin = window.location.origin;
    const storage = window.localStorage, prototype = window.Storage.prototype;
    const names = ['setItem', 'removeItem', 'clear'];
    const descriptors = Object.fromEntries(names.map(name => [name, Object.getOwnPropertyDescriptor(prototype, name)]));
    const native = Object.fromEntries(names.map(name => [name, descriptors[name].value]));
    const previousLocks = Object.getOwnPropertyDescriptor(window.navigator, 'locks');
    const client = {window, storage, native, requests:new Set(), disconnect:null};
    native.clear.call(storage);
    for (const [key, value] of values) native.setItem.call(storage, key, value);
    const update = (method, ...args) => {
      // Retain each window's real Storage object so key/length/enumeration and
      // StorageEvent.storageArea have native identity and branding.
      for (const member of clients) member.native[method].call(member.storage, ...args);
    };
    Object.defineProperties(prototype, {
      setItem: {...descriptors.setItem, value:function(key, value) {
        if (this !== storage) return native.setItem.apply(this, arguments);
        if (arguments.length < 2) throw new window.TypeError('setItem requires two arguments');
        key = String(key); value = String(value);
        const oldValue = values.has(key) ? values.get(key) : null;
        if (oldValue === value) return;
        update('setItem', key, value); values.set(key, value);
        enqueue(client, key, oldValue, value);
      }},
      removeItem: {...descriptors.removeItem, value:function(key) {
        if (this !== storage) return native.removeItem.apply(this, arguments);
        if (!arguments.length) throw new window.TypeError('removeItem requires one argument');
        key = String(key);
        if (!values.has(key)) return;
        const oldValue = values.get(key);
        update('removeItem', key); values.delete(key);
        enqueue(client, key, oldValue, null);
      }},
      clear: {...descriptors.clear, value:function() {
        if (this !== storage) return native.clear.apply(this, arguments);
        if (!values.size) return;
        update('clear'); values.clear();
        enqueue(client, null, null, null);
      }}
    });
    clients.add(client);
    if (locks) Object.defineProperty(window.navigator, 'locks', {configurable:true, value:lockManager(client)});
    client.disconnect = () => {
      if (!clients.delete(client)) return;
      for (const request of [...client.requests]) {
        // Discard the closing realm's requests without running its promise
        // handlers after window.close(); other windows can acquire the locks.
        finishLock(request, undefined, false, true);
      }
      if (previousLocks) Object.defineProperty(window.navigator, 'locks', previousLocks);
      else delete window.navigator.locks;
      Object.defineProperties(prototype, descriptors);
      queue = queue.filter(event => event.recipient !== client);
      if (!queue.length) cancelTimer();
    };
    return client.disconnect;
  }
  return {
    connect, flush,
    snapshot: () => Object.fromEntries(values),
    get pendingCount() { return queue.length; },
    get windowCount() { return clients.size; },
    close() { for (const client of [...clients]) client.disconnect(); cancelTimer(); queue = []; }
  };
}

async function createGame(options = {}) {
  const storageHub = options.storageHub || createStorageHub(options.storage || {}, {locks: options.locks !== false});
  const input = options.input || path.join(__dirname, '..', 'index.html');
  const html = fs.readFileSync(input, 'utf8');
  let dimensions = { width: options.width || 390, height: options.height || 550, dpr: options.dpr || 1 };
  const pixels = new WeakMap(), raf = new Map(), runtimeErrors = [];
  let nextRAF = 1, now = 1000, inputTime = 1000, disconnectStorage = () => {};
  const rect = (width, height) => ({x:0,y:0,left:0,top:0,right:width,bottom:height,width,height,toJSON(){return {...this};}});
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => { if (error.type !== 'css-parsing') runtimeErrors.push(error.stack || String(error)); });
  const dom = new JSDOM(html, {
    url: options.url || 'https://pore-master-clinic.test/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
    beforeParse(w) {
      w.addEventListener('error', e => runtimeErrors.push(e.error?.stack || e.message));
      // Mechanics suites can explicitly request the historical customer mix.
      // Install the fixture before the game's load handler so normal startup,
      // session validation and hydration still execute without resetting saves.
      // Product/default adventure tests always use the real level recipes.
      if (options.legacyRecipe) w.addEventListener('load', () => {
        w.eval('if (typeof adventureRecipeFor === "function") adventureRecipeFor = () => careRecipeFor(currentClient(), state.targetDensity);');
      }, {once:true});
      disconnectStorage = storageHub.connect(w);
      for (const [key, value] of Object.entries(options.storage || {})) w.localStorage.setItem(key, value);
      if (options.seed !== undefined) {
        let seed = options.seed >>> 0;
        w.Math.random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
      }
      Object.defineProperty(w, 'devicePixelRatio', {get:()=>dimensions.dpr});
      Object.defineProperty(w, 'innerWidth', {get:()=>dimensions.width});
      Object.defineProperty(w, 'innerHeight', {get:()=>dimensions.height+240});
      w.ImageData = ImageData; w.Path2D = Path2D;
      w.matchMedia = query => ({matches:false,media:query,onchange:null,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){},dispatchEvent(){return true;}});
      w.requestAnimationFrame = fn => {const id=nextRAF++;raf.set(id,fn);return id;};
      w.cancelAnimationFrame = id => raf.delete(id);
      w.ResizeObserver = class { constructor(fn){this.fn=fn;} observe(target){this.fn([{target,contentRect:target.getBoundingClientRect()}]);} unobserve(){} disconnect(){} };
      w.HTMLElement.prototype.scrollIntoView = function(){};
      w.HTMLElement.prototype.getBoundingClientRect = function() {
        if (['viewport-wrap','skin-canvas'].includes(this.id)) return rect(dimensions.width, dimensions.height);
        if (['ba-compare-box','compare-canvas'].includes(this.id)) return rect(360,130);
        if (this.id==='tray-zoom-canvas') return rect(360,190);
        return rect(dimensions.width,40);
      };
      // jsdom has no layout. Model the existing dialogs' visibility so focus
      // checks use the same controls as the browser; CSS geometry is checked
      // separately in browser acceptance.
      w.HTMLElement.prototype.getClientRects = function() {
        if (!this.isConnected || this.closest('[hidden], [inert], .modal-backdrop:not(.open)')) return [];
        const closedDetails = this.closest('details:not([open])');
        if (closedDetails && !closedDetails.querySelector(':scope > summary')?.contains(this)) return [];
        return [this.getBoundingClientRect()];
      };
      const prototype = w.HTMLCanvasElement.prototype;
      const nativeFor = element => {
        if (!pixels.has(element)) {
          const canvas = createCanvas(Math.max(1,element.width), Math.max(1,element.height));
          const native = canvas.getContext('2d');
          const proxy = new Proxy(native, {
            get(target,key) {
              if(key==='canvas') return element;
              if(key==='drawImage') return (source,...args)=>target.drawImage(source instanceof w.HTMLCanvasElement?nativeFor(source).canvas:source,...args);
              if(key==='createPattern') return (source,...args)=>target.createPattern(source instanceof w.HTMLCanvasElement?nativeFor(source).canvas:source,...args);
              const value=Reflect.get(target,key,target);
              return typeof value==='function'?value.bind(target):value;
            },
            set(target,key,value){return Reflect.set(target,key,value,target);}
          });
          pixels.set(element,{canvas,native,proxy});
        }
        return pixels.get(element);
      };
      for(const dimension of ['width','height']) {
        const descriptor=Object.getOwnPropertyDescriptor(prototype,dimension);
        Object.defineProperty(prototype,dimension,{...descriptor,set(value){descriptor.set.call(this,value);if(pixels.has(this))pixels.get(this).canvas[dimension]=Math.max(1,descriptor.get.call(this));}});
      }
      prototype.getContext=function(kind){if(kind!=='2d')return null;return nativeFor(this).proxy;};
      prototype.toDataURL=function(...args){return nativeFor(this).canvas.toDataURL(...args);};
      if (options.setupWindow) options.setupWindow(w);
    }
  });
  const w=dom.window,d=w.document,evaluate=source=>w.eval(source);
  if(d.readyState!=='complete')await new Promise(resolve=>w.addEventListener('load',resolve,{once:true}));
  await evaluate('typeof careControlReady === "undefined" ? undefined : careControlReady');
  if (!options.stayHome) {
    const enter = d.getElementById('btn-start-adventure');
    if (enter?.closest('.modal-backdrop.open') && !enter.disabled) {
      enter.click();
      await Promise.resolve();
    }
  }
  const frame=(count=1,dt=1000/60)=>{for(let i=0;i<count;i++){now+=dt;const callbacks=[...raf.values()];raf.clear();for(const callback of callbacks)callback(now);}};
  const timestampInput=(event, timestamp)=>{inputTime=timestamp ?? Math.max(now,inputTime+1000/60);Object.defineProperty(event,'timeStamp',{value:inputTime});return event;};
  const mouse=(target,type,x,y,timestamp)=>{if(typeof target==='string')target=d.getElementById(target);target.dispatchEvent(timestampInput(new w.MouseEvent(type,{bubbles:true,button:0,buttons:type==='mouseup'?0:1,clientX:x,clientY:y}),timestamp));};
  const touch=(type,touches,changedTouches=touches,timestamp)=>{const event=timestampInput(new w.Event(type,{bubbles:true,cancelable:true}),timestamp);Object.defineProperties(event,{touches:{value:touches},changedTouches:{value:changedTouches}});d.getElementById('skin-canvas').dispatchEvent(event);};
  const click=id=>{const element=d.getElementById(id);if(!element)throw new Error('Missing #'+id);element.click();};
  const resize=(width,height,dpr=dimensions.dpr)=>{dimensions={width,height,dpr};w.dispatchEvent(new w.Event('resize'));};
  const storage=()=>Object.fromEntries(Array.from({length:w.localStorage.length},(_,i)=>{const key=w.localStorage.key(i);return [key,w.localStorage.getItem(key)];}));
  const close=()=>{disconnectStorage();w.close();};
  return {w,d,evaluate,state:evaluate,frame,mouse,touch,click,resize,storage,close,runtimeErrors,pixels};
}
module.exports={createGame,createStorageHub};

