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
for(const name of ['balance','rules','codec']) runInContext(readFileSync(new URL(`../apps/web/public/miniapps/backyard/${name}.js`,import.meta.url),'utf8'),context);
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
    console.log(JSON.stringify({databaseName,rawBytes:Buffer.byteLength(JSON.stringify(dto)),pgColumnSize:row.bytes,serviceRoundTrip:true,httpPutGet:true,authentication:'일회용 사용자 주입'}));
  } finally { await app.close(); }
  const boundary={padding:'x'.repeat(8178)};assert.equal(Buffer.byteLength(JSON.stringify(boundary)),8192);
  await assert.rejects(service.save(user.id,'backyard','boundary',{householdId:household.id,state:boundary}),error=>error.cause?.constraint_name==='play_states_state_size');
  console.log('raw 8192는 서비스 크기 검사를 통과하지만 DB jsonb CHECK에서 거절됨');
  await assert.rejects(service.save(user.id,'backyard','boundary',{householdId:household.id,state:{padding:'x'.repeat(8179)}}),error=>error.status===413);
  console.log('PlayService raw 8193의 413 거절 통과');
} finally { await client.end(); }
