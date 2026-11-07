import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectLearning, validateLearning } from '../learning.mjs';
const stable = '我平时负责声学实验室设备交付，工作汇报一直习惯先列风险再讲进展。';
const body = stable+'\n请整理设备交付检查清单，并区分可以现场完成与需要提前准备的内容。';
const session = texts => ({session:{id:'synthetic'},events:texts.flatMap((text,i)=>[
  {type:'user/message',seq:2*i,time:100+i,data:{source:{kind:'user'},content:[{type:'text',text}]}},
  {type:'turn/end',seq:2*i+1,time:100+i,data:{turn:i+1,reason:{kind:'completed'}}},
])});
test('personal paragraphs reach the learner verbatim; a final fact still needs an exact single-line excerpt', () => {
  const batch = collectLearning(session([body]));
  assert.deepEqual(batch.messages,[{seq:0,text:body}]);
  const quote='我平时负责声学实验室设备交付';
  const change={action:'add',ids:[],messageSeq:0,quote,fact:{kind:'identity',title:'声学实验室设备交付',content:quote},reason:'本人长期职责'};
  assert.equal(validateLearning({changes:[change]},batch,{facts:[],usage:{nearCapacity:false}}).length,1);
  assert.throws(()=>validateLearning({changes:[{...change,quote:body,fact:{...change.fact,content:body}}]},batch,{facts:[],usage:{nearCapacity:false}}));
  assert.throws(()=>validateLearning({changes:[{...change,quote:stable.replace('平时','始终')}]},batch,{facts:[],usage:{nearCapacity:false}}));
});
test('multiline source does not bypass attribution, stop or credential exclusion', () => {
  for(const text of ['引用同事的话：\n'+stable, '这次别记\n'+stable, '我长期使用的密码是合成口令\nSYNTHETIC-ONLY']) assert.equal(collectLearning(session([text])).messages.length,0);
  assert.equal(collectLearning(session(['这次别记',body])).messages.length,0);
});
