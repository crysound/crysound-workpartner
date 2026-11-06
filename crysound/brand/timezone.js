// Some embedded browsers report UTC despite a Beijing device clock.
// Run before the frontend; explicit zones and serialized instants stay unchanged.
(() => {
  const installed = Symbol.for("crysound.timezone-fallback");
  if (globalThis[installed]) return;
  const NativeFormat = Intl.DateTimeFormat;
  const zeroZones = new Set([
    "UTC", "Etc/UTC", "GMT", "Etc/GMT", "GMT0", "Etc/GMT0", "Etc/GMT+0", "Etc/GMT-0",
    "UCT", "Etc/UCT", "Universal", "Etc/Universal", "Zulu", "Etc/Zulu", "Greenwich", "Etc/Greenwich",
  ]);
  if (new Date().getTimezoneOffset() !== 0 || !zeroZones.has(NativeFormat().resolvedOptions().timeZone)) return;
  Object.defineProperty(globalThis, installed, { value: true });

  const defaultZone = (options) => {
    if (options === null || options?.timeZone !== undefined) return options;
    // Keep inherited/non-enumerable Intl options, including locale and calendar settings.
    return Object.defineProperty(Object.create(options === undefined ? null : Object(options)), "timeZone", {
      value: "Asia/Shanghai", enumerable: true,
    });
  };
  Intl.DateTimeFormat = new Proxy(NativeFormat, {
    apply(target, receiver, [locales, options]) {
      return Reflect.apply(target, receiver, [locales, defaultZone(options)]);
    },
    construct(target, [locales, options], newTarget) {
      return Reflect.construct(target, [locales, defaultZone(options)], newTarget);
    },
  });
  for (const name of ["toLocaleString", "toLocaleDateString", "toLocaleTimeString"]) {
    const native = Date.prototype[name];
    Date.prototype[name] = function (locales, options) {
      return native.call(this, locales, defaultZone(options));
    };
  }

  // dsh clocks/calendar helpers also read local fields and calculate local midnight.
  // Modern company timestamps use Beijing's UTC+08:00; UTC accessors remain native.
  const offset = 8 * 60 * 60 * 1000;
  const { getTime, setTime, toDateString } = Date.prototype;
  const shifted = (date) => new Date(getTime.call(date) + offset);
  for (const field of ["FullYear", "Month", "Date", "Day", "Hours", "Minutes", "Seconds", "Milliseconds"]) {
    const get = Date.prototype[`getUTC${field}`];
    Date.prototype[`get${field}`] = function () { return get.call(shifted(this)); };
    if (field === "Day") continue;
    const set = Date.prototype[`setUTC${field}`];
    Date.prototype[`set${field}`] = function (...args) {
      return setTime.call(this, set.apply(shifted(this), args) - offset);
    };
  }
  Date.prototype.getTimezoneOffset = function () { return Number.isNaN(getTime.call(this)) ? NaN : -480; };
  Date.prototype.toDateString = function () { return toDateString.call(shifted(this)); };
})();
