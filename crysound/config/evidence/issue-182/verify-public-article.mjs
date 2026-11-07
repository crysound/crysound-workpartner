// Public, unbilled probe through the pinned fetch artifact and company pipeline; no container or paid credentials.
import { released, WebError } from '../../../web/web-tools/release-fixture.mjs';
import { companyFetcher } from '../../../web/web-tools/fetch.mjs';
import { fetchPage } from '../../../web/web-tools/fetch-pipeline.mjs';
const { HttpFetchProvider } = await released('dsh-web-fetch-http');
const limits={ maxResponseBytes:500000,maxBodyChars:100000,timeoutMs:10000,maxRedirects:5,userAgent:'unused' };
const url='https://m.chinanews.com/wap/detail/chs/zw/10714120.shtml';
const ctx={web:companyFetcher(HttpFetchProvider,WebError,limits,{loadRuntime:()=>{throw Error('Unexpected Chromium');}})};
const config={fetchSummary:false,fetchTreg:true,fetchDeepSeek:true,fetchDirectTimeoutMs:1500,fetchTregTimeoutMs:8000,fetchDeepSeekTimeoutMs:8000,fetchTotalTimeoutMs:9500,fetchWechatTimeoutMs:3500,fetchPublicArticleTimeoutMs:3500};
const start=performance.now();let fallbacks=0;
try {
 const result=await fetchPage(ctx,config,{url},'',value=>({text:value.body.content,truncated:value.truncated}),AbortSignal.timeout(10000),{launchEnvironmentOf:()=>{fallbacks++;return new Map();}});
 const report={url:result.url,status:result.statusCode,chars:result.body.content.length,excerpt:result.body.content.slice(0,280),hasPrice:result.body.content.includes('299'),elapsedMs:Math.round(performance.now()-start),fallbackEnvironmentReads:fallbacks};
 console.log(JSON.stringify(report,null,2));
 if(result.url!==url || !report.hasPrice || fallbacks) process.exitCode=1;
} catch(error) { console.log(JSON.stringify({error:error.message,code:error.code,elapsedMs:Math.round(performance.now()-start),fallbackEnvironmentReads:fallbacks}));process.exitCode=1; }
