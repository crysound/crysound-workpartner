import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createMarket } from '../market.mjs';
import { parseMarketIndex } from '../../../../packages/util/plugin-market-index/src/index.ts';

const name = '@crysound/design';
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'market-counts-'));
  const stateFile = path.join(root, 'market.json');
  fs.writeFileSync(stateFile, JSON.stringify({format:1,packages:{[name]:{owner:'publisher',versions:{'1.0.0':{status:'approved',publisher:'publisher',publishTimestamp:1}}}}}));
  const officialPlugins = JSON.parse(fs.readFileSync(new URL('../../../config/plugins.json', import.meta.url))).officialPlugins;
  let upstreamStatus = 200;
  const options = {stateFile,registry:'https://registry.test',authorization:'test-only',publicOrigin:'https://market.test',
    authenticate:req=>req.headers.authorization === 'test-only' ? {slug:'tester'} : null,sessionUser:()=>null,readUsers:()=>[],admins:[],officialPlugins,
    fetcher:async url=>url.endsWith('.tgz') ? new Response('package',{status:upstreamStatus}) : Response.json({versions:{'1.0.0':{name,version:'1.0.0',description:'Design',dist:{tarball:'https://registry.test/design-1.0.0.tgz'}}}}),
  };
  let handler = createMarket(options);
  const server = http.createServer(async(req,res)=>{await handler(req,res,new URL(req.url,'https://market.test'));});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});});
  const request = (route,init={}) => fetch(`http://127.0.0.1:${server.address().port}${route}`,{headers:{authorization:'test-only'},...init});
  const index = async()=>parseMarketIndex(await (await request('/_zp/market/index.json')).json(),'https://market.test/_zp/market/index.json');
  return {root,stateFile,request,index,restart:()=>{handler=createMarket(options);},failDownload:()=>{upstreamStatus=503;}};
}

test('只有完成的下载累计；读取、HEAD、未授权和失败不累计，并发后重启保留匿名总数',async t=>{
  const f=await fixture(t);
  const count=async()=> (await f.index()).plugins[0].metadata.sortKeys['crysound-installs'];
  assert.equal(await count(),0);
  const route='/_zp/npm/@crysound/design/-/design-1.0.0.tgz';
  await (await f.request(route,{method:'HEAD'})).arrayBuffer();
  assert.equal((await f.request(route,{headers:{}})).status,401);
  assert.equal(await count(),0);
  await Promise.all(Array.from({length:8},async()=>{const r=await f.request(route);assert.equal(r.status,200);assert.equal(await r.text(),'package');}));
  // A response may reach the client just before its durable counter write completes.
  for(let i=0;await count()!==8 && i<30;i++) await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(await count(),8);
  f.restart();assert.equal(await count(),8);
  f.failDownload();assert.equal((await f.request(route)).status,503);assert.equal(await count(),8);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.stateFile+'.installs')),{[name]:8});
  assert.equal(fs.statSync(f.stateFile+'.installs').mode&0o777,0o600);
  const icon=(await f.index()).plugins[0].icon;assert.ok(icon.startsWith('data:image/svg+xml;base64,'));
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(f.stateFile))),['format','packages']);
});

test('损坏的统计文件不会被静默清零',async t=>{
  const f=await fixture(t);
  fs.writeFileSync(f.stateFile+'.installs','{"@crysound/design":-1}');
  assert.throws(f.restart,/安装统计无效/);
  assert.equal(fs.readFileSync(f.stateFile+'.installs','utf8'),'{"@crysound/design":-1}');
});
