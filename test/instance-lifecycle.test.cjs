const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');
const ts = require('typescript');
function methods(file, names, dependencies = {}) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const members = source.statements.filter(ts.isClassDeclaration).flatMap(n => [...n.members]);
  const selected = names.map(name => {
    const member = members.find(n => n.name?.getText(source) === name);
    assert.ok(member, name); return member.getText(source);
  });
  const js = ts.transpileModule(`class Subject { ${selected.join('\n')} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return new Function(...Object.keys(dependencies), `${js}; return Subject.prototype;`)(...Object.values(dependencies));
}
const base = 'src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts';
const wa = methods(base, ['logoutInstance', 'confirmLocalLogoutCleanup', 'connectToWhatsapp', 'connectionUpdate', 'eventHandler', 'createClient', 'createClientSocket'], {
  Events: {}, DisconnectReason: { loggedOut: 401, forbidden: 403 },
  setTimeout: (fn) => setTimeout(fn, 20), clearTimeout,
});
const controller = methods('src/api/controllers/instance.controller.ts', ['logout', 'deleteInstance', 'connectToWhatsapp', 'restartInstance'], {
  Events: {}, BadRequestException: Error, InternalServerErrorException: Error,
});
const monitor = methods('src/api/services/monitor.service.ts', ['removeInstanceData'], { Events: {} });
const defer = () => { let resolve; const promise = new Promise(r => resolve=r); return {promise,resolve}; };
function fixture(logout = async () => {}) {
  const actions=[];
  const subject=Object.assign(Object.create(wa), {
    endSession:false, connectionGeneration:0, logoutOperation:null,
    credentialWrite:Promise.resolve(),authStateOperation:Promise.resolve(),connectionWrite:Promise.resolve(),
    connectionOperation:null,terminalCleanup:null,eventProcessingQueue:Promise.resolve(),
    instanceId:'a',instanceName:'a',instance:{id:'a',name:'a',qrcode:{count:0}},
    client:{user:{id:'test@s.whatsapp.net'},logout, end(){actions.push('end');},ws:{close(){actions.push('close');}}},
    messageProcessor:{onDestroy(){actions.push('destroy');}},
    configService:{get(name){return name==='DATABASE'?{SAVE_DATA:{INSTANCE:false}}:name==='CACHE'?{REDIS:{ENABLED:false}}:{};}},
    prismaRepository:{session:{deleteMany:async args=>{assert.deepEqual(args,{where:{sessionId:'a'}});actions.push('credentials');}},instance:{update:async args=>{assert.equal(args.where.id,'a');actions.push(args.data.connectionStatus);}}},
    logger:{error(){},warn(){},info(){}},findSettings:async()=>({}),
  });
  return {subject,actions};
}
test('successful logout drains writes, stops reconnect and preserves conversations',async()=>{
  const {subject,actions}=fixture(); const pending=defer(); subject.credentialWrite=pending.promise;
  const result=subject.logoutInstance(); await new Promise(r=>setImmediate(r));
  assert.equal(subject.endSession,true); assert.equal(actions.includes('credentials'),false);
  pending.resolve(); await result;
  assert.deepEqual(actions,['destroy','end','close','credentials','close']);
  assert.equal(subject.connectionStatus,undefined); assert.equal(subject.stateConnection.state,'close');
  await subject.connectionUpdate({connection:'close'}); // Must not reconnect.
});
for(const [label,logout] of [['reject',async()=>{throw Error('network');}],['timeout',()=>new Promise(()=>{})]]){
  test('remote '+label+' stops locally without claiming remote logout',async()=>{
    const {subject,actions}=fixture(logout);
    await assert.rejects(subject.logoutInstance(),e=>e.localShutdownComplete===true);
    assert.ok(actions.includes('credentials')); assert.equal(subject.stateConnection.state,'close');
  });
}
test('failed previous credential writes do not permanently block cleanup',async()=>{
  const {subject,actions}=fixture(); subject.credentialWrite=Promise.reject(Error('old write')); subject.credentialWrite.catch(()=>{});
  await subject.logoutInstance(); assert.ok(actions.includes('credentials'));
});
test('unfinished writes fail bounded without deleting credentials or allowing reconnect',async()=>{
  const {subject,actions}=fixture();const write=defer();subject.credentialWrite=write.promise;
  await assert.rejects(subject.logoutInstance(),/still finishing/);
  assert.equal(actions.includes('credentials'),false);
  await assert.rejects(subject.connectToWhatsapp(),/stopping/);
  write.resolve();await subject.logoutInstance();assert.ok(actions.includes('credentials'));
});
test('pending auth creation is drained and cannot create a socket after logout',async()=>{
  const {subject,actions}=fixture();const auth=defer();subject.defineAuthState=()=>auth.promise;
  const connection=subject.createClient();const rejection=assert.rejects(connection,/superseded/);
  const logout=subject.logoutInstance();await new Promise(r=>setImmediate(r));
  assert.equal(actions.includes('credentials'),false);auth.resolve({state:{creds:{}}});
  await rejection;await logout;assert.ok(actions.includes('credentials'));
});
test('obsolete socket events and missing-user open events do not write or throw',async()=>{
  const {subject,actions}=fixture(); const old={}; await subject.connectionUpdate({connection:'open'},old);
  subject.client.user=undefined; await subject.connectionUpdate({connection:'open'},subject.client);
  assert.deepEqual(actions,[]);
  let callback;subject.client.ev={process(fn){callback=fn;}};subject.eventHandler();
  subject.client={}; await callback({'creds.update':{}});await subject.eventProcessingQueue;
  assert.deepEqual(actions,[]);
});
test('open event waiting on profile cannot restore open state after logout',async()=>{
  const {subject}=fixture();const profile=defer();subject.profilePicture=()=>profile.promise;
  const opened=subject.connectionUpdate({connection:'open'});await subject.logoutInstance();
  profile.resolve({profilePictureUrl:null});await opened;
  assert.equal(subject.stateConnection.state,'close');
});
test('local cleanup failure never grants deletion fallback',async()=>{
  const {subject}=fixture();subject.prismaRepository.session.deleteMany=async()=>{throw Error('database');};
  await assert.rejects(subject.logoutInstance(),e=>!e.localShutdownComplete);
});
test('monitor cleanup failure blocks reconnect until a successful logout retry',async()=>{
  const {subject}=fixture();let fail=true;
  const c=Object.assign(Object.create(controller),{loggingOutInstances:new Set(),waMonitor:{waInstances:{a:subject},cleaningUp:async()=>{if(fail)throw Error('filesystem');}}});
  await assert.rejects(c.logout({instanceName:'a'}),/filesystem/);
  await assert.rejects(subject.connectToWhatsapp(),/stopping/);
  fail=false;await c.logout({instanceName:'a'});assert.equal(subject.localShutdownPending,false);
});
test('deletion waits cleanup, isolates instances and surfaces cleanup errors',async()=>{
  const gate=defer();const actions=[];
  const m=Object.assign(Object.create(monitor),{removalOperations:new Map(),waInstances:{a:{},b:{}},logger:{warn(){},error(){}},clearDelInstanceTime(){},
    cleaningUp:async name=>{assert.equal(name,'a');actions.push('auth');await gate.promise;},cleaningStoreData:async name=>{assert.equal(name,'a');actions.push('store');}});
  const result=m.removeInstanceData('a');await new Promise(r=>setImmediate(r));assert.ok(m.waInstances.a);assert.deepEqual(actions,['auth']);
  gate.resolve();await result;assert.equal(m.waInstances.a,undefined);assert.ok(m.waInstances.b);
  m.waInstances.a={};m.cleaningStoreData=async()=>{throw Error('database');};await assert.rejects(m.removeInstanceData('a'));assert.ok(m.waInstances.a);
});
test('explicit deletion distinguishes remote unknown from local failure and blocks reconnect while pending',async()=>{
  let deleted=0;const gate=defer();
  const c=Object.assign(Object.create(controller),{deletingInstances:new Set(),loggingOutInstances:new Set(),configService:{get:()=>({ENABLED:false})},logger:{error(){}},
    waMonitor:{cleaningUp:async()=>{},waInstances:{a:{logoutInstance:async()=>{throw Object.assign(Error('remote'),{localShutdownComplete:true});}}},removeInstanceData:async()=>{await gate.promise;deleted++;}}});
  const result=c.deleteInstance({instanceName:'a'});await new Promise(r=>setImmediate(r));
  await assert.rejects(c.connectToWhatsapp({instanceName:'a'}),/progress/);assert.equal(deleted,0);
  gate.resolve();const response=await result;assert.equal(response.response.remoteLogoutConfirmed,false);assert.equal(deleted,1);
  c.waMonitor.waInstances.a.logoutInstance=async()=>{throw Error('cleanup failed');};
  await assert.rejects(c.deleteInstance({instanceName:'a'}));assert.equal(deleted,1);
});
