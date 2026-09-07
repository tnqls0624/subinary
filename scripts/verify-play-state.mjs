/** 일회용 DB에서 실제 PlayService·codec 최대 DTO를 왕복 검사한다. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { assertVerificationDatabaseSafety, assertDisposableVerificationDatabaseName } from './lib/verification-database-guard.mjs';
import { createDbClient, schema } from '../packages/database/dist/index.mjs';
const { databaseName } = assertVerificationDatabaseSafety({ databaseUrl:process.env.DATABASE_URL,allowWrite:process.env.PLAY_VERIFY_ALLOW_WRITE,nodeEnv:process.env.NODE_ENV });
assertDisposableVerificationDatabaseName(databaseName);
const require=createRequire(import.meta.url);
const { PlayService }=require('../apps/api/dist/play/play.service.js');
const { db,client }=createDbClient(process.env.DATABASE_URL);
const context=createContext({});
for(const name of ['balance','rules','codec','rpg-codec','rpg-rules','rpg-session']) runInContext(readFileSync(new URL(`../apps/web/public/miniapps/backyard/${name}.js`,import.meta.url),'utf8'),context);
const codec=runInContext('BackyardCodec.createCodec()',context);
const max=Number.MAX_SAFE_INTEGER;
const result=codec.serializeGarden({lastSavedAtSec:max,seed:4294967295,fruit:max,purchasedPots:16,unlocked:['p','w','c'],placements:Array.from({length:16},(_,i)=>({kind:'p',cell:{row:Math.floor(i/4),col:i%4},readyAtSec:max}))},max);
assert.equal(result.status,'ok');
const dto=JSON.parse(JSON.stringify(result.value));
try {
  const [user]=await db.insert(schema.users).values({email:`play-verify-${randomUUID()}@invalid`,passwordHash:'x'.repeat(32),name:'저장 검증'}).returning();
  const [household]=await db.insert(schema.households).values({name:'일회용 저장 검증 가구',createdBy:user.id}).returning();
  await db.insert(schema.householdMembers).values({householdId:household.id,userId:user.id,role:'owner',status:'active'});
  const service=new PlayService(db);
  const saved=await service.save(user.id,'backyard','garden',{householdId:household.id,state:dto});
  assert.deepEqual(saved.state,dto);
  const read=await service.list(user.id,household.id,'backyard');assert.deepEqual(read[0].state,dto);
  const [row]=await client`SELECT pg_column_size(state) AS bytes FROM play_states WHERE household_id=${household.id} AND app_key='backyard' AND state_key='garden'`;
  assert.ok(row.bytes<=8192);
  const apiRequire=createRequire(new URL('../apps/api/package.json',import.meta.url));
  const { NestFactory }=apiRequire('@nestjs/core');
  const { Module }=apiRequire('@nestjs/common');
  const { FastifyAdapter }=apiRequire('@nestjs/platform-fastify');
  const { ZodValidationPipe }=apiRequire('nestjs-zod');
  const { PlayController }=apiRequire('./dist/play/play.controller.js');
  class VerifyPlayModule {}
  Module({controllers:[PlayController],providers:[{provide:PlayService,useValue:service}]})(VerifyPlayModule);
  const adapter=new FastifyAdapter({forceCloseConnections:true});
  // 인증만 일회용 사용자로 대체하고 실제 컨트롤러·검증 파이프·서비스·DB를 사용한다.
  adapter.getInstance().addHook('preHandler',async request=>{request.user={userId:user.id,email:user.email};});
  const app=await NestFactory.create(VerifyPlayModule,adapter,{logger:false});
  try {
    app.setGlobalPrefix('v1');app.useGlobalPipes(new ZodValidationPipe());
    await app.listen(0,'127.0.0.1');
    const base=await app.getUrl();
    const put=await fetch(`${base}/v1/play/backyard/garden`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({householdId:household.id,state:dto})});
    assert.equal(put.status,200);assert.deepEqual((await put.json()).state,dto);
    const get=await fetch(`${base}/v1/play/backyard?householdId=${household.id}`);
    assert.equal(get.status,200);assert.deepEqual((await get.json()).items[0].state,dto);
    const rpg=runInContext('BackyardRpgCodec',context),life=runInContext('BackyardRpgLife',context);
    const canonical=value=>JSON.parse(JSON.stringify(value));
    const maximum={
      rpg_meta:{v:2,mapVersion:1,seed:4294967295,initialized:true,migrated:false},
      rpg_world:{v:2,legacyFruit:max,items:Array.from({length:48},(_,i)=>`${i}:p:${16+i%16}:${21+Math.floor(i/16)}`)},
      rpg_collection:{v:2,species:Array.from({length:16},(_,i)=>`s${i}:99:${max}:node-11`),nodes:[...Array.from({length:12},(_,i)=>`node-${i}:${max}`),...Array.from({length:48},(_,i)=>`pot-${i}:${max}`)],fishing:[7,7,7],completed:true},
      rpg_residents:{v:2,items:Array.from({length:3},(_,i)=>`r${i}:4095:23:4294967295:s15`)},
      rpg_player:{v:2,mapVersion:1,x:511,y:383,direction:7,outfit:1,t:max},
    };
    const putState=(key,state)=>fetch(`${base}/v1/play/backyard/${key}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({householdId:household.id,state})});
    async function saveState(key,state){const response=await putState(key,state);assert.equal(response.status,200);assert.deepEqual((await response.json()).state,canonical(state));}
    async function readStates(){const response=await fetch(`${base}/v1/play/backyard?householdId=${household.id}`);assert.equal(response.status,200);return Object.fromEntries((await response.json()).items.map(item=>[item.stateKey,item.state]));}
    const sizes={};
    for(const key of rpg.keys){
      assert.equal(rpg.decode(key,maximum[key]).status,'ok');await saveState(key,maximum[key]);
      assert.deepEqual((await readStates())[key],maximum[key]);
      const [stored]=await client`SELECT pg_column_size(state) AS bytes FROM play_states WHERE household_id=${household.id} AND app_key='backyard' AND state_key=${key}`;
      sizes[key]={raw:Buffer.byteLength(JSON.stringify(maximum[key])),pgColumnSize:stored.bytes};assert(sizes[key].raw<=8192&&stored.bytes<=8192);
    }
    const failed=await putState('rpg_collection',{padding:'x'.repeat(8192)});assert.equal(failed.status,413);
    const afterFailure=await readStates();for(const key of rpg.keys)assert.deepEqual(afterFailure[key],maximum[key]);
    // 실제 HTTP bridge로 제품 session의 garden 이전과 meta 마지막 쓰기를 실행한다.
    await client`DELETE FROM play_states WHERE household_id=${household.id} AND app_key='backyard' AND state_key LIKE 'rpg_%'`;
    const legacy={v:1,t:1000,s:1,f:123,n:0,k:['p','w','c'],p:['p:0:9999','w:15','c:4']};await saveState('garden',legacy);
    const writes=[];
    const migratedSession=runInContext('BackyardRpgSession',context).createSession({bridge:{ready:async()=>{},state:{get:async key=>(await readStates())[key]??null,set:async(key,state)=>{await saveState(key,state);writes.push(key);}}},setTimer:setTimeout,clearTimer:clearTimeout});
    await migratedSession.load();assert.equal(migratedSession.getState().status,'playable');migratedSession.destroy();
    const migrated=await readStates(),expected=canonical(rpg.migrate(legacy).data);
    for(const key of rpg.keys)assert.deepEqual(migrated[key],expected[key]);assert.deepEqual(migrated.garden,legacy);
    assert.deepEqual(writes,['rpg_world','rpg_collection','rpg_residents','rpg_player','rpg_meta']);
    // 둘 다 같은 GET을 읽은 후 B를 먼저 ACK하고, 오래된 A를 늦게 PUT한다.
    const a=await readStates(),b=await readStates();
    const changeA=canonical(life.gather(a.rpg_collection,'node-0',10000));
    const changeB=canonical(life.gather(b.rpg_collection,'node-8',10000));
    await saveState('rpg_collection',changeB);const acknowledgedB=(await readStates()).rpg_collection;
    const worldB={...b.rpg_world,items:b.rpg_world.items.map(t=>t.startsWith('2:')?'2:c:b':t)};await saveState('rpg_world',worldB);
    await saveState('rpg_collection',changeA);const final=await readStates();
    assert.deepEqual(final.rpg_collection,changeA);assert.deepEqual(final.rpg_world,worldB);
    assert(!final.rpg_collection.species.some(t=>t.startsWith('s4:')));assert(!final.rpg_collection.nodes.some(t=>t.startsWith('node-8:')));
    const conflicts=[{key:'rpg_collection',order:['B ACK','A late ACK'],acknowledgedB,final:final.rpg_collection,lost:{discoveries:['s4'],count:1,firstSeenAt:10000,nodeReadyAt:['node-8:10060']},differentKeyPreserved:'rpg_world'}];
    // world도 같은 정책이다. A의 늦은 의자 이동이 B의 화분 이동을 덮는다.
    const worldBase=final.rpg_world,worldA={...worldBase,items:worldBase.items.map(t=>t.startsWith('2:')?'2:c:7:20':t)},worldOther={...worldBase,items:worldBase.items.map(t=>t.startsWith('0:')?'0:p:8:20':t)};
    await saveState('rpg_world',worldOther);await saveState('rpg_world',worldA);
    const worldFinal=(await readStates()).rpg_world;assert.deepEqual(worldFinal,worldA);conflicts.push({key:'rpg_world',order:['B ACK','A late ACK'],lost:{placement:'0:p:8:20'},final:worldFinal});
    console.log('RPG_RESULT '+JSON.stringify({databaseName,sizes,fiveKeyHttpPutGet:true,failedKeyStatus:failed.status,allOtherKeysPreserved:true,migration:{writes,gardenUnchanged:true,world:migrated.rpg_world,collection:migrated.rpg_collection},conflicts,policy:'기존 마지막 쓰기 우선 유지; 같은 키 무손실 동시 편집은 해결하지 않음',authentication:'일회용 사용자 주입; 실제 컨트롤러·파이프·서비스·PostgreSQL'}));
    console.log(JSON.stringify({databaseName,rawBytes:Buffer.byteLength(JSON.stringify(dto)),pgColumnSize:row.bytes,serviceRoundTrip:true,httpPutGet:true,authentication:'일회용 사용자 주입'}));
  } finally { await app.close(); }
  const boundary={padding:'x'.repeat(8178)};assert.equal(Buffer.byteLength(JSON.stringify(boundary)),8192);
  await assert.rejects(service.save(user.id,'backyard','boundary',{householdId:household.id,state:boundary}),error=>error.cause?.constraint_name==='play_states_state_size');
  console.log('raw 8192는 서비스 크기 검사를 통과하지만 DB jsonb CHECK에서 거절됨');
  await assert.rejects(service.save(user.id,'backyard','boundary',{householdId:household.id,state:{padding:'x'.repeat(8179)}}),error=>error.status===413);
  console.log('PlayService raw 8193의 413 거절 통과');
} finally { await client.end(); }
