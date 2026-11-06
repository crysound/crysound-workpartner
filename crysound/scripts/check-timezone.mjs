// Run with Node: node crysound/scripts/check-timezone.mjs. No dependencies or build.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const fallback = readFileSync(new URL('../brand/timezone.js', import.meta.url), 'utf8');
const probe = `
  import assert from 'node:assert/strict';
  const stamp = '2026-11-06T23:02:03.456Z';
  const snapshot = () => {
    const d = new Date(stamp);
    const options = Object.create({ year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const local = Object.fromEntries(['FullYear', 'Month', 'Date', 'Day', 'Hours', 'Minutes', 'Seconds', 'Milliseconds', 'TimezoneOffset'].map(f => [f, d['get' + f]()]));
    const setters = Object.fromEntries(['2026-12-31T23:02:00Z', '2026-02-28T23:02:00Z'].flatMap(at =>
      [['Hours', 0, 0, 0, 0], ['Hours', 24, 0, 0, 0], ['Date', 1], ['Month', 1, 28], ['FullYear', 2028], ['Minutes', 90], ['Seconds', 90], ['Milliseconds', 2000]].map(([field, ...args]) => {
        const date = new Date(at);
        const result = date['set' + field](...args);
        assert.equal(result, date.getTime());
        return [at + field + args.join(','), date.toISOString()];
      })));
    const format = Intl.DateTimeFormat('en-GB', options);
    assert(format instanceof Intl.DateTimeFormat);
    class Format extends Intl.DateTimeFormat {}
    assert.equal(new Format('en-GB').resolvedOptions().timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone);
    return {
      local, setters, dateString: d.toDateString(), zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      format: format.format(d), parts: format.formatToParts(d), range: format.formatRange(d, new Date(d.getTime() + 86400000)),
      locale: ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString'].map(name => d[name]('en-GB', { hourCycle: 'h23' })),
      defaultTimingStart: new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16),
      absolute: { epoch: d.getTime(), json: JSON.stringify(d), iso: d.toISOString(), utc: d.toUTCString(), hours: d.getUTCHours() },
      explicit: ['UTC', 'Asia/Tokyo', 'America/New_York'].map(timeZone => ({
        formatted: new Intl.DateTimeFormat('en-GB', { ...options, timeZone, dateStyle: 'full', timeStyle: 'long' }).format(d),
        locale: ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString'].map(name => d[name]('en-GB', { timeZone })),
      })),
    };
  };
  const before = snapshot();
  const formatBefore = Intl.DateTimeFormat, hoursBefore = Date.prototype.getHours;
  const install = () => { ${fallback} };
  install();
  const after = snapshot();
  assert.deepEqual(after.absolute, before.absolute);
  assert.deepEqual(after.explicit, before.explicit);
  assert(Number.isNaN(new Date(NaN).getHours()));
  assert(Number.isNaN(new Date(NaN).getTimezoneOffset()));
  assert.equal(new Date(NaN).toDateString(), 'Invalid Date');
  const invalid = new Date(NaN);
  assert(Number.isNaN(invalid.setHours(0)));
  assert.throws(() => Intl.DateTimeFormat('en', null), TypeError);
  assert.throws(() => new Intl.DateTimeFormat('en', { timeZone: 'invalid' }), RangeError);
  assert.deepEqual(Intl.DateTimeFormat.supportedLocalesOf(['en', 'zh']), formatBefore.supportedLocalesOf(['en', 'zh']));
  const formatAfter = Intl.DateTimeFormat, hoursAfter = Date.prototype.getHours;
  install();
  assert.equal(Intl.DateTimeFormat, formatAfter);
  assert.equal(Date.prototype.getHours, hoursAfter);
  assert.deepEqual(snapshot(), after);
  console.log(JSON.stringify({ before, after, changed: formatAfter !== formatBefore || hoursAfter !== hoursBefore }));
`;

const results = new Map();
for (const zone of ['UTC', 'Etc/GMT', 'Asia/Shanghai', 'Asia/Tokyo', 'America/New_York', 'Europe/London', 'Africa/Abidjan']) {
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    env: { ...process.env, TZ: zone }, encoding: 'utf8',
  });
  assert.equal(run.status, 0, `${zone}: ${run.stderr}`);
  results.set(zone, JSON.parse(run.stdout));
}
for (const [zone, result] of results) {
  const enabled = zone === 'UTC' || zone === 'Etc/GMT';
  assert.equal(result.changed, enabled, zone);
  assert.deepEqual(result.after, enabled ? results.get('Asia/Shanghai').before : result.before, zone);
  console.log(`${zone}: ${enabled ? 'Beijing fallback' : 'unchanged'}; formatting, local fields, midnight, explicit zones, instants, repeat load passed`);
}
