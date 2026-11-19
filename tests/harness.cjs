/* Deterministic DOM input and real Canvas pixels. CSS layout, audio quality,
 * real touch hardware and battery consumption require a browser/device check. */
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { createCanvas, ImageData, Path2D } = require('@napi-rs/canvas');

async function createGame(options = {}) {
  const input = options.input || path.join(__dirname, '..', 'index.html');
  const html = fs.readFileSync(input, 'utf8');
  let dimensions = { width: options.width || 390, height: options.height || 550, dpr: options.dpr || 1 };
  const pixels = new WeakMap(), raf = new Map(), runtimeErrors = [];
  let nextRAF = 1, now = 1000;
  const rect = (width, height) => ({x:0,y:0,left:0,top:0,right:width,bottom:height,width,height,toJSON(){return {...this};}});
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => { if (error.type !== 'css-parsing') runtimeErrors.push(error.stack || String(error)); });
  const dom = new JSDOM(html, {
    url: 'https://pore-master-clinic.test/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
    beforeParse(w) {
      w.addEventListener('error', e => runtimeErrors.push(e.error?.stack || e.message));
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
    }
  });
  const w=dom.window,d=w.document,evaluate=source=>w.eval(source);
  if(d.readyState!=='complete')await new Promise(resolve=>w.addEventListener('load',resolve,{once:true}));
  const frame=(count=1,dt=1000/60)=>{for(let i=0;i<count;i++){now+=dt;const callbacks=[...raf.values()];raf.clear();for(const callback of callbacks)callback(now);}};
  const mouse=(target,type,x,y)=>{if(typeof target==='string')target=d.getElementById(target);target.dispatchEvent(new w.MouseEvent(type,{bubbles:true,button:0,buttons:type==='mouseup'?0:1,clientX:x,clientY:y}));};
  const touch=(type,touches,changedTouches=touches)=>{const event=new w.Event(type,{bubbles:true,cancelable:true});Object.defineProperties(event,{touches:{value:touches},changedTouches:{value:changedTouches}});d.getElementById('skin-canvas').dispatchEvent(event);};
  const click=id=>{const element=d.getElementById(id);if(!element)throw new Error('Missing #'+id);element.click();};
  const resize=(width,height,dpr=dimensions.dpr)=>{dimensions={width,height,dpr};w.dispatchEvent(new w.Event('resize'));};
  const storage=()=>Object.fromEntries(Array.from({length:w.localStorage.length},(_,i)=>{const key=w.localStorage.key(i);return [key,w.localStorage.getItem(key)];}));
  const close=()=>w.close();
  return {w,d,evaluate,state:evaluate,frame,mouse,touch,click,resize,storage,close,runtimeErrors,pixels};
}
module.exports={createGame};
