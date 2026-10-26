// Exercise the actual CORS options and API-key guard without starting WhatsApp workers.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { once } = require('node:events');
const test = require('node:test');
const ts = require('typescript');
const express = require('express');
const cors = require('cors');
function find(file, predicate) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  let match;
  function visit(node) { if (!match && predicate(node)) match = node; ts.forEachChild(node, visit); }
  visit(source);
  assert.ok(match, file);
  return match.getText(source);
}
const options = find('src/main.ts', n => ts.isCallExpression(n) && n.expression.getText() === 'cors');
const guard = find('src/api/guards/auth.guard.ts', n => ts.isFunctionDeclaration(n) && n.name?.text === 'apikey');
const configService = { get(name) {
  if (name === 'CORS') return { ORIGIN: ['https://panaugust.com', 'https://wa.panaugust.com'], METHODS: ['GET','POST'], CREDENTIALS: true };
  if (name === 'AUTHENTICATION') return { API_KEY: { KEY: 'test-only-global-key' } };
  if (name === 'DATABASE') return { SAVE_DATA: { INSTANCE: true } };
  throw Error('Unexpected configuration');
}};
const js = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const middleware = new Function('cors', 'configService', js('const middleware = '+options+';')+'return middleware;')(cors, configService);
class UnauthorizedException extends Error { constructor() { super('Unauthorized'); this.status=401; } }
const auth = new Function('configService','prismaRepository','logger','UnauthorizedException','ForbiddenException',js(guard)+'return apikey;')(
  configService, {instance:{findUnique:async()=>({token:'test-only-instance-key'}),findFirst:async()=>null}}, {error(){}}, UnauthorizedException, UnauthorizedException,
);
test('CORS allows server calls without weakening API-key protection or browser allowlist', async t => {
  const app=express();
  app.use(middleware);
  app.get('/', (_req,res)=>res.json({status:'ok'}));
  app.get('/instance/connectionState/:instanceName',(req,res,next)=>Promise.resolve(auth(req,res,next)).catch(next),(_req,res)=>res.json({instance:{state:'open'}}));
  app.use((err,_req,res,_next)=>res.status(err.status||500).json({error:err.message}));
  const server=app.listen(0,'127.0.0.1'); await once(server,'listening');
  const base='http://127.0.0.1:'+server.address().port;
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const request=(headers,path='/instance/connectionState/panaugust-wa',method='GET')=>fetch(base+path,{headers,method});
  await t.test('direct navigation works without permissive CORS headers', async()=>{
    const r=await request({},'/'); assert.equal(r.status,200); assert.equal(r.headers.get('access-control-allow-origin'),null);
  });
  for(const [label,key,expected] of [['missing',undefined,401],['invalid','wrong-key',401],['global','test-only-global-key',200],['instance','test-only-instance-key',200]]) {
    await t.test('server request with '+label+' key',async()=>{
      const r=await request(key?{apikey:key}:{}); assert.equal(r.status,expected); assert.equal(r.headers.get('access-control-allow-origin'),null);
    });
  }
  for(const origin of ['https://panaugust.com','https://wa.panaugust.com']) {
    await t.test('allowed browser '+origin+' still needs authentication',async()=>{
      const denied=await request({Origin:origin});assert.equal(denied.status,401);
      const allowed=await request({Origin:origin,apikey:'test-only-global-key'});assert.equal(allowed.status,200);assert.equal(allowed.headers.get('access-control-allow-origin'),origin);
      const preflight=await request({Origin:origin,'Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'apikey'},undefined,'OPTIONS');assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-origin'),origin);
    });
  }
  for(const origin of ['https://untrusted.example','https://panaugust.com.untrusted.example','http://panaugust.com','null','']) {
    await t.test('reject unapproved Origin '+JSON.stringify(origin),async()=>{
      const r=await request({Origin:origin,apikey:'test-only-global-key'});assert.equal(r.status,500);assert.equal(r.headers.get('access-control-allow-origin'),null);
    });
  }
});
