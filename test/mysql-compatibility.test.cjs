// Run against a disposable, migrated local database with DATABASE_PROVIDER=mysql:
// node --test test/mysql-compatibility.test.cjs
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const test = require('node:test');
const ts = require('typescript');
const { Prisma, PrismaClient } = require('@prisma/client');

function repositoryClass(Client) {
  const code = ts.transpileModule(readFileSync('src/api/repository/repository.service.ts', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  new Function('require', 'exports', code)((name) => {
    if (name === '@prisma/client') return { PrismaClient: Client };
    if (name === '@config/logger.config') return { Logger: class { info() {} warn() {} } };
    throw new Error(`Unexpected dependency: ${name}`);
  }, exports);
  return exports.PrismaRepository;
}

test('MySQL pool is bounded without rewriting credentials or explicit pool settings', () => {
  const Repository = repositoryClass(class { constructor(options) { this.options = options; } });
  const configured = (provider, uri) => new Repository({ get: () => ({ PROVIDER: provider, CONNECTION: { URI: uri } }) });
  const uri = 'mysql://user:p%40ss%26word@localhost:3306/test?sslaccept=strict';
  assert.equal(configured('mysql', uri).options.datasourceUrl, uri + '&connection_limit=2&pool_timeout=30');
  const explicit = uri + '&connection_limit=4&pool_timeout=15';
  assert.equal(configured('mysql', explicit).options.datasourceUrl, explicit);
  assert.equal(configured('mysql', 'mysql://localhost/test').options.datasourceUrl,
    'mysql://localhost/test?connection_limit=2&pool_timeout=30');
  assert.equal(configured('postgresql', 'postgresql://localhost/test').options, undefined);
});

// Execute the actual service methods without importing server.module or starting WhatsApp/network workers.
function methods(file, names) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const members = source.statements.filter(ts.isClassDeclaration).flatMap((node) => [...node.members]);
  const selected = names.map((name) => {
    const member = members.find((node) => node.name?.getText(source) === name);
    assert.ok(member, `${file}: ${name} exists`);
    return member.getText(source);
  });
  const js = ts.transpileModule(`class Subject { ${selected.join('\n')} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return new Function('Prisma', 'cuid', 'isArray', 'status', 'createJid', `${js}; return Subject.prototype;`)(
    Prisma, randomUUID, Array.isArray, { 3: 'DELIVERY_ACK', 4: 'READ' }, (jid) => `${jid}@s.whatsapp.net`,
  );
}

const repository = methods('src/api/repository/repository.service.ts', ['isMysql', 'jsonPath']);
const channel = methods('src/api/services/channel.service.ts', ['fetchMessages', 'fetchChats']);
const whatsapp = methods('src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts', [
  'getMessage', 'updateMessagesReadedByTimestamp', 'updateChatUnreadMessages', 'addLabel', 'removeLabel',
]);
const chatwoot = methods('src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts', [
  'getMessageByKeyId', 'updateChatwootMessageId',
]);

test('JSON paths follow the provider, including escaped member names', () => {
  for (const provider of ['mysql', 'postgresql', 'psql_bouncer']) {
    const receiver = Object.create(repository);
    receiver.configService = { get: () => ({ PROVIDER: provider }) };
    const segments = ['key.with.dot', 'quoted"key'];
    assert.deepEqual(receiver.jsonPath(...segments), provider === 'mysql' ? '$."key.with.dot"."quoted\\"key"' : segments);
  }
});

test('MySQL/MariaDB service operations preserve data and instance isolation', async (t) => {
  assert.equal(process.env.DATABASE_PROVIDER, 'mysql');
  const uri = new URL(process.env.DATABASE_CONNECTION_URI);
  assert.ok(['127.0.0.1', 'localhost'].includes(uri.hostname));
  assert.match(uri.pathname, /^\/evolution_mysql_test_\d+$/);
  const Repository = repositoryClass(PrismaClient);
  const db = new Repository({ get: () => ({ PROVIDER: 'mysql', CONNECTION: { URI: process.env.DATABASE_CONNECTION_URI } }) });
  const base = {
    prismaRepository: db,
    instanceId: 'instance-a',
    cleanMessageData: (message) => message,
    logger: { verbose() {}, error() {} },
    isImportHistoryAvailable: () => false,
  };
  const wa = Object.assign(Object.create(whatsapp), base);
  const chats = Object.assign(Object.create(channel), base);
  const cw = Object.assign(Object.create(chatwoot), base);
  const jid = '966500000001@s.whatsapp.net';
  const now = Math.floor(Date.now() / 1000);
  try {
    await t.test('history-sized query burst reuses at most two database connections', async () => {
      const results = await Promise.all(Array.from({ length: 400 }, () =>
        db.$queryRaw`SELECT CONNECTION_ID() AS connectionId, SLEEP(0.005) AS waited`));
      assert.ok(new Set(results.map(rows => String(rows[0].connectionId))).size <= 2);
      assert.equal(results.length, 400);
    });
    await db.instance.createMany({ data: [{ id: 'instance-a', name: 'a' }, { id: 'instance-b', name: 'b' }] });
    await db.chat.createMany({ data: [
      { id: 'chat-b', instanceId: 'instance-b', remoteJid: jid, name: 'Other account', unreadMessages: 9 },
      { id: 'chat-a', instanceId: 'instance-a', remoteJid: jid, name: 'Arabic العربية', unreadMessages: 2 },
    ] });
    for (const [id, instanceId, fromMe, time] of [
      ['incoming', 'instance-a', false, now - 10],
      ['outgoing', 'instance-a', true, now],
      ['other-account', 'instance-b', false, now + 10],
    ]) {
      await db.message.create({ data: {
        id, instanceId, key: { id: fromMe ? 'sent' : 'shared-id', remoteJid: jid, fromMe },
        messageType: 'conversation', message: { conversation: 'مرحبا' }, source: 'web',
        status: 'DELIVERY_ACK', messageTimestamp: time,
      } });
    }

    await t.test('JSON filters accept strings and booleans and retain scope', async () => {
      const result = await chats.fetchMessages({ where: { key: { fromMe: true, remoteJid: jid } } });
      assert.deepEqual(result.messages.records.map((m) => m.id), ['outgoing']);
      assert.equal(result.messages.total, 1);
      const message = await wa.getMessage({ id: 'shared-id' }, true);
      assert.equal(message.id, 'incoming');
      assert.equal((await wa.getMessage({ id: 'shared-id' })).conversation, 'مرحبا');
      assert.equal(await cw.getMessageByKeyId({ instanceId: 'instance-a' }, "' OR 1=1 --"), null);
    });

    await t.test('read receipt updates do not touch outgoing or other-account messages/chats', async () => {
      assert.equal(await wa.updateMessagesReadedByTimestamp(jid, now), 1);
      assert.equal((await db.message.findUnique({ where: { id: 'incoming' } })).status, 'READ');
      assert.equal((await db.message.findUnique({ where: { id: 'outgoing' } })).status, 'DELIVERY_ACK');
      assert.equal((await db.message.findUnique({ where: { id: 'other-account' } })).status, 'DELIVERY_ACK');
      assert.equal((await db.chat.findUnique({ where: { id: 'chat-b' } })).unreadMessages, 9);
      assert.equal((await db.chat.findUnique({ where: { id: 'chat-a' } })).unreadMessages, 0);
    });

    await t.test('chat list returns newest message, JSON objects, booleans and pagination', async () => {
      const result = await chats.fetchChats({});
      assert.equal(result.length, 1);
      assert.equal(result[0].lastMessage.id, 'outgoing');
      assert.equal(result[0].lastMessage.key.remoteJid, jid);
      assert.equal(result[0].lastMessage.message.conversation, 'مرحبا');
      assert.equal(typeof result[0].windowActive, 'boolean');
      assert.equal(result[0].pushName, 'Arabic العربية');
      assert.deepEqual(await chats.fetchChats({ skip: 1 }), []);
      assert.deepEqual(await chats.fetchChats({ where: { remoteJid: "x' OR 1=1 --@s.whatsapp.net" } }), []);
      const filtered = await chats.fetchChats({ where: { messageTimestamp: {
        gte: new Date((now - 15) * 1000).toISOString(), lte: new Date((now - 5) * 1000).toISOString(),
      } }, take: 1 });
      assert.equal(filtered[0].lastMessage.id, 'incoming');
    });

    await t.test('synced chats without saved messages remain visible and instance scoped', async () => {
      const emptyJid='123456789000@g.us';
      await db.chat.createMany({data:[
        {id:'empty-a',instanceId:'instance-a',remoteJid:emptyJid,name:'Synced group'},
        {id:'empty-b',instanceId:'instance-b',remoteJid:'966599999999@s.whatsapp.net',name:'Private account'},
      ]});
      try {
        const result=await chats.fetchChats({});
        assert.equal(result.length,2);
        const empty=result.find(c=>c.remoteJid===emptyJid);
        assert.equal(empty.pushName,'Synced group');
        assert.equal(empty.lastMessage,undefined);
        assert.equal(result.some(c=>c.pushName==='Private account'),false);
        assert.equal((await chats.fetchChats({where:{remoteJid:emptyJid}})).length,1);
        const first=await chats.fetchChats({take:1});
        const second=await chats.fetchChats({take:1,skip:1});
        assert.notEqual(first[0].remoteJid,second[0].remoteJid);
        assert.deepEqual(await chats.fetchChats({where:{remoteJid:emptyJid,messageTimestamp:{gte:new Date((now-15)*1000).toISOString(),lte:new Date((now+15)*1000).toISOString()}}}),[]);
      } finally {await db.chat.deleteMany({where:{id:{in:['empty-a','empty-b']}}});}
    });

    await t.test('label operations are atomic, literal and scoped', async () => {
      await Promise.all(['a', 'b', 'a', 'x%_!', "quote'"].map((label) => wa.addLabel(label, 'instance-a', jid)));
      let chat = await db.chat.findUnique({ where: { id: 'chat-a' } });
      assert.deepEqual([...chat.labels].sort(), ['a', 'b', 'x%_!', "quote'"].sort());
      await wa.removeLabel('x%_!', 'instance-a', jid);
      await wa.removeLabel('absent', 'instance-a', jid);
      chat = await db.chat.findUnique({ where: { id: 'chat-a' } });
      assert.deepEqual([...chat.labels].sort(), ['a', 'b', "quote'"].sort());
      assert.equal((await db.chat.findUnique({ where: { id: 'chat-b' } })).labels, null);
      await wa.removeLabel('absent', 'instance-a', 'new@s.whatsapp.net');
      assert.deepEqual((await db.chat.findFirst({ where: { instanceId: 'instance-a', remoteJid: 'new@s.whatsapp.net' } })).labels, []);
    });

    await t.test('compound label identity and LID cache can be written and read', async () => {
      const identity = { labelId: 'label', instanceId: 'instance-a' };
      for (const name of ['first', 'updated']) await db.label.upsert({
        where: { labelId_instanceId: identity }, create: { ...identity, name, color: '1' }, update: { name },
      });
      await db.label.create({ data: { ...identity, instanceId: 'instance-b', name: 'other', color: '2' } });
      assert.equal((await db.label.findUnique({ where: { labelId_instanceId: identity } })).name, 'updated');
      await db.isOnWhatsapp.create({ data: { remoteJid: jid, jidOptions: jid, lid: '123@lid' } });
      assert.equal((await db.isOnWhatsapp.findUnique({ where: { remoteJid: jid } })).lid, '123@lid');
    });

    await t.test('Chatwoot IDs update only the matching account', async () => {
      await cw.updateChatwootMessageId({ key: { id: 'shared-id' } }, { messageId: 42, isRead: true }, { instanceId: 'instance-a' });
      assert.equal((await cw.getMessageByKeyId({ instanceId: 'instance-a' }, 'shared-id')).chatwootMessageId, 42);
      assert.equal((await cw.getMessageByKeyId({ instanceId: 'instance-b' }, 'shared-id')).chatwootMessageId, null);
    });
    await t.test('large synced history can be paged within the inbox request deadline', async () => {
      await db.instance.create({data:{id:'history-account',name:'history-account'}});
      await db.chat.createMany({data:Array.from({length:3300},(_,i)=>({
        id:`history-chat-${i}`,instanceId:'history-account',remoteJid:`966600${String(i).padStart(4,'0')}@s.whatsapp.net`,
      }))});
      for(let batch=0;batch<51;batch++) {
        await db.message.createMany({data:Array.from({length:1000},(_,i)=>{
          const n=batch*1000+i;
          return {id:`history-message-${n}`,instanceId:'history-account',
            key:{id:`history-key-${n}`,remoteJid:`966600${String(n%3300).padStart(4,'0')}@s.whatsapp.net`,fromMe:false},
            messageType:'conversation',message:{conversation:'Synthetic history'},source:'web',messageTimestamp:now+n};
        })});
      }
      const started=performance.now();
      const result=await db.$transaction(async tx=>{
        await tx.$executeRawUnsafe('SET SESSION max_statement_time = 15');
        const reader=Object.assign(Object.create(channel),base,{instanceId:'history-account',prismaRepository:{isMysql:true,$queryRaw:tx.$queryRaw.bind(tx)}});
        return reader.fetchChats({take:20});
      },{timeout:20000});
      const elapsed=performance.now()-started;
      t.diagnostic(`History page query: ${Math.round(elapsed)}ms`);
      assert.equal(result.length,20);
      assert.equal(new Set(result.map(chat=>chat.remoteJid)).size,20);
      assert.deepEqual(result.map(chat=>chat.lastMessage.id),Array.from({length:20},(_,i)=>`history-message-${50999-i}`));
      assert.ok(elapsed<12000,'chat page must finish before the 12-second inbox timeout');
    });
  } finally {
    await db.$disconnect();
  }
});
