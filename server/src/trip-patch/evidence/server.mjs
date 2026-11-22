import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
const root=process.env.STASH_ROOT
const load=async p=>import(pathToFileURL(root+'/'+p).href)
const require=createRequire(root+'/server/package.json')
const {serve}=require('@hono/node-server')
const {createApp}=await load('server/src/app.ts')
const {createSqliteDatabase}=await load('server/src/db/driver.ts')
const {ensureSchema}=await load('server/src/db/schema.ts')
const db=createSqliteDatabase(':memory:')
await ensureSchema(db)
const tripId='stash-evidence-trip', dayId='stash-evidence-day'
await db.run("INSERT INTO trips(id,title,start_date,end_date,created_at,updated_at) VALUES (?,?,'2026-10-02','2026-10-02','2026-09-01','2026-09-01')",[tripId,'候选池进入日程'])
await db.run("INSERT INTO days(id,trip_id,idx,date,theme,color) VALUES (?,?,0,'2026-10-02','成都慢游','#3f7d5c')",[dayId,tripId])
const poi={id:'legacy-poi',amapId:'legacy-poi',name:'人民公园',lat:30.658,lng:104.056,category:'城市公园',type:'attraction',region:'成都',rating:4.5,introSummary:'公园散步',address:'成都市青羊区',images:[]}
await db.run("INSERT INTO stash(id,trip_id,poi,origin,added_at) VALUES ('legacy-stash',?,?,'favorite','2026-09-01')",[tripId,JSON.stringify(poi)])
await db.run("INSERT INTO favorites(id,trip_id,poi,created_at) VALUES ('legacy-favorite',?,?,'2026-09-01')",[tripId,JSON.stringify(poi)])
await db.run("INSERT INTO items(id,trip_id,day_id,item_order,type,title,note,poi,pending,time_range,cost) VALUES ('anchor',?,?,0,'attraction','宽窄巷子','慢行起点',?,0,'09:00','免费')",[tripId,dayId,JSON.stringify({name:'宽窄巷子',location:{lat:30.668,lng:104.05},amapId:'anchor',category:'街区'})])
let calls=0, round=0
const model={specificationVersion:'v2',provider:'test.stash-evidence',modelId:'scripted-stash',supportedUrls:Promise.resolve({}),doGenerate:async()=>{throw Error('unused')},doStream:async()=>{
 const stage=calls++%3
 if(stage===0)round++
 const proposal={kind:'optimize',title:'候选池排期建议',summary:'将人民公园排入当天，保留晚餐灵感待计划。',diff:[{action:'add',label:'保存晚餐灵感',detail:'纯文本候选，不创建虚构坐标'},{action:'move',label:'人民公园加入当天',detail:'保留收藏，自动更新相邻交通段'}],patch:{ops:[{op:'add_stash',stashId:'dinner-'+round,title:round===1?'晚餐灵感':'晚餐灵感 '+round,note:'  到店再选，预算 ¥80/人  ',category:'自由想法',poi:null},...(round===1?[{op:'move_stash_to_day',stashId:'legacy-stash',itemId:'scheduled-park',dayId}]:[])]}}
 if(round===3)proposal.patch.ops=[{op:'add_stash',stashId:'same-poi-breakfast',title:'早餐想法',note:'早上来',poi:{...poi,id:'local-breakfast'}},{op:'add_stash',stashId:'same-poi-dinner',title:'晚餐想法',note:'晚上来',poi},{op:'add_stash',stashId:'same-poi-supper',title:'夜宵想法',note:'暂不安排',poi}]
 const parts=stage===0?[{type:'tool-call',toolCallId:'snapshot-'+round,toolName:'read_trip_snapshot',input:'{}'}]:stage===1?[{type:'tool-call',toolCallId:'proposal-'+round,toolName:'create_trip_proposal',input:JSON.stringify(proposal)}]:[{type:'text-start',id:'t'},{type:'text-delta',id:'t',delta:'建议已生成。'},{type:'text-end',id:'t'}]
 parts.push({type:'finish',finishReason:stage===2?'stop':'tool-calls',usage:{inputTokens:1,outputTokens:1,totalTokens:2}})
 return {stream:new ReadableStream({start(c){for(const part of parts)c.enqueue(part);c.close()}})}
}}
const ctor=async(path,name)=>{const m=await load(path);return m[name]}
const TripRepository=await ctor('server/src/trips/repository.ts','TripRepository')
const SqliteTripStoreDriver=await ctor('server/src/trips/driver-sqlite.ts','SqliteTripStoreDriver')
const TripContentRepository=await ctor('server/src/content/repository.ts','TripContentRepository')
const SqliteContentStoreDriver=await ctor('server/src/content/driver-sqlite.ts','SqliteContentStoreDriver')
const factory=async(path,name)=>(await load(path))[name](db)
const app=await createApp({databaseUrl:':memory:',seedBuiltinTrip:false,plannerModel:model,
 tripRepository:new TripRepository(new SqliteTripStoreDriver(db)),contentRepository:new TripContentRepository(new SqliteContentStoreDriver(db)),guideImportDatabase:db,
 workbenchStore:await factory('server/src/days/driver-sqlite.ts','createSqliteWorkbenchStore'),daysAdminStore:await factory('server/src/days-admin/driver-sqlite.ts','createSqliteDaysAdminStore'),itemsAdminStore:await factory('server/src/items-admin/driver-sqlite.ts','createSqliteItemsAdminStore'),toolsStore:await factory('server/src/tools/driver-sqlite.ts','createSqliteToolsStore'),recommendationsStore:await factory('server/src/recommendations/driver-sqlite.ts','createSqliteRecommendationsStore'),tripPatchStore:await factory('server/src/trip-patch/store-sqlite.ts','createSqliteTripPatchStore'),messageStore:new (await ctor('server/src/chat/driver-sqlite.ts','SqliteMessageStoreDriver'))(db),aiProviderStore:new (await ctor('server/src/ai-providers/driver-sqlite.ts','SqliteAiProviderStoreDriver'))(db),searchPoi:async()=>[],routeLegs:async()=>({status:'pending',source:'pending',distanceKm:null,durationMin:null,polyline:null})})
const server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:0})
if(!server.listening)await new Promise(r=>server.once('listening',r))
console.log('READY '+server.address().port)
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{server.closeAllConnections();server.close(async()=>{await db.close();process.exit(0)})})
