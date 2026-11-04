'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs');
const {baseUrl,AiKeyStore}=require('../../app/openai-compatible');
const {TextIntelService}=require('../../app/text-intel');
const {makeTmpDir,rmrf}=require('./helpers');
function service(t, ai, fetchImpl=fetch){const dir=makeTmpDir('openai');t.after(()=>rmrf(dir));return new TextIntelService({dataDir:dir,settings:{get:key=>key==='ai'?ai:undefined},fetchImpl,windowContextProvider:{}});}
test('custom endpoints retain prefixes and require opt-in for remote hosts',()=>{
 assert.equal(baseUrl('http://localhost:8000/proxy/v1/'),'http://localhost:8000/proxy/v1');
 assert.throws(()=>baseUrl('https://llm.internal/v1'),/Enable/);assert.equal(baseUrl('https://llm.internal/v1',true),'https://llm.internal/v1');
 for(const value of ['file:///tmp/a','http://user:key@localhost/v1','http://localhost/v1?token=key','http://localhost/v1#x'])assert.throws(()=>baseUrl(value));
});
test('encrypted keys are endpoint-bound, can be removed, and never fall back to plaintext',t=>{
 const dir=makeTmpDir('ai-key');t.after(()=>rmrf(dir));const storage={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s).map(b=>b^91),decryptString:b=>Buffer.from(b.map(x=>x^91)).toString()};
 const keys=new AiKeyStore(dir,storage);keys.set('http://localhost/v1','fixture-secret');assert.equal(keys.get('http://localhost/v1/'),'fixture-secret');assert.equal(keys.get('http://localhost/other'),'');assert.ok(!fs.readFileSync(keys.file).includes(Buffer.from('fixture-secret')));
 keys.storage={isEncryptionAvailable:()=>false};assert.equal(keys.get('http://localhost/keyless'),'');assert.throws(()=>keys.get('http://localhost/v1'),/keyring/);keys.storage=storage;
 keys.set('http://localhost/v1','');assert.equal(keys.get('http://localhost/v1'),'');assert.throws(()=>new AiKeyStore(dir,{isEncryptionAvailable:()=>false}).set('http://localhost/v1','secret'),/encryption/);
});
test('connection testing uses actual compatible chat, accepts custom models and optional authentication',async t=>{
 const requests=[];const server=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;requests.push({path:req.url,key:req.headers.authorization,body:JSON.parse(body)});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:'{"title":"Ready"}'}}]}));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
 const host=`http://127.0.0.1:${server.address().port}/gateway/v1`;const ai={enabled:true,provider:'openai',openai:{baseUrl:host,model:'company/custom-model'}};const svc=service(t,ai);
 const result=await svc.testAiConnection();assert.equal(result.ok,true);assert.equal(requests[0].path,'/gateway/v1/chat/completions');assert.equal(requests[0].key,undefined);assert.equal(requests[0].body.model,'company/custom-model');assert.equal(requests[0].body.stream,false);
 assert.equal((await svc.testAiConnection({openai:{apiKey:'test-token'}})).ok,true);assert.equal(requests[1].key,'Bearer test-token');
 const ready=svc.readyAiConfig();assert.equal(await svc.callOllama({...ready,prompt:'Write JSON',systemPrompt:'Only JSON',images:['cG5n']}),'{"title":"Ready"}');assert.equal(requests.at(-1).body.messages[1].content[1].image_url.url,'data:image/png;base64,cG5n');assert.equal(await svc.modelSupportsVision(ready),false);ai.openai.vision=true;assert.equal(await svc.modelSupportsVision(ready),true);
 const {GuideStore}=require('../../core/store');const dir=makeTmpDir('compatible-generation');t.after(()=>rmrf(dir));const store=new GuideStore(dir),guide=store.createGuide({title:'Account setup'}),step=store.addStep(guide.guideId,{title:'Review account'});svc.store=store;
 const generated=await svc.generateStepPatch({guideId:guide.guideId,stepId:step.stepId,target:'title'});assert.equal(generated.ok,true);assert.equal(store.getStep(guide.guideId,step.stepId).title,'Ready');
});
test('incompatible servers and authentication errors fail clearly without echoing secrets',async t=>{
 const ai={provider:'openai',openai:{baseUrl:'http://localhost/v1',model:'custom'}};
 for(const response of [{ok:false,status:401},{ok:true,json:async()=>({choices:[]})},{ok:true,json:async()=>{throw Error('bad JSON');}}]){const svc=service(t,ai,async()=>response);const result=await svc.testAiConnection({openai:{apiKey:'secret'}});assert.equal(result.ok,false);assert.ok(!result.reason.includes('secret'));}
});
test('compatible requests inherit cancellation, deadlines and redirect blocking',async t=>{
 let redirect;const ai={enabled:true,provider:'openai',timeoutMs:15,openai:{baseUrl:'http://localhost/v1',model:'custom'}};
 const svc=service(t,ai,(_url,opts)=>{redirect=opts.redirect;return new Promise((_resolve,reject)=>opts.signal.addEventListener('abort',()=>reject(Error('aborted'))));});
 assert.equal((await svc.testAiConnection()).ok,false);assert.equal(redirect,'error');assert.equal(svc.inflight.size,0);
 ai.timeoutMs=10000;const pending=svc.callOllama({...svc.readyAiConfig(),guideId:'guide',prompt:'hello',systemPrompt:'JSON'});await new Promise(r=>setTimeout(r,5));svc.cancelInflight('guide');await assert.rejects(pending,/cancelled/);
});

test('real response-body stalls time out and real redirects never forward a key',async t=>{
 let redirected=0;const server=http.createServer((req,res)=>{
  if(req.url.startsWith('/redirect/')){res.writeHead(302,{Location:'/target'});res.end();}
  else if(req.url==='/target'){redirected++;res.end('{}');}
  else {res.writeHead(200,{'Content-Type':'application/json'});res.flushHeaders();}
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
 const host=`http://127.0.0.1:${server.address().port}`;const svc=service(t,{provider:'openai',timeoutMs:30,openai:{baseUrl:host+'/slow/v1',model:'test'}});
 const slow=await svc.testAiConnection();assert.equal(slow.ok,false);assert.match(slow.reason,/timed out/);
 const redirect=await svc.testAiConnection({openai:{baseUrl:host+'/redirect/v1',apiKey:'fixture-key'}});assert.equal(redirect.ok,false);assert.equal(redirected,0);
});
