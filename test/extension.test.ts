import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import fs from "node:fs";

const url = "https://allegro.pl/listing?string=mishima&price_to=50";
const watch = { monitorId: 1, name: "old", url, tabId: 1, enabled: true, intervalMinutes: 5, nextCheckAt: 0 };
function deferred() { let resolve!: (value?: any) => void; const promise = new Promise<any>(r => { resolve = r; }); return { promise, resolve }; }
function harness(initial: any = {}) {
  let saved: any = { token: "test", watched: [{ ...watch }], unread: [], receivedThrough: 0, ...initial };
  let listener: any;
  const updated = new Set<any>();
  const h: any = { tabs: [{ id: 1, url }], posts: [], notices: [],
    request: async () => ({ monitors: [], notifications: [] }), read: async () => ({ empty: true, listings: [], diagnostic: { url } }) };
  const noop = () => {};
  const chrome = {
    storage: { local: { get: async (defaults: any) => structuredClone({ ...defaults, ...saved }), set: async (patch: any) => { saved = structuredClone({ ...saved, ...patch }); } } },
    alarms: { get: async () => true, onAlarm: { addListener: noop } },
    action: { setBadgeBackgroundColor: async () => {}, setBadgeText: async () => {} },
    runtime: { onInstalled: { addListener: noop }, onStartup: { addListener: noop }, onMessage: { addListener: (fn: any) => { listener = fn; } } },
    notifications: { create: async (...args: any[]) => h.notices.push(args) },
    tabs: { query: async () => structuredClone(h.tabs), get: async (id: number) => h.tabs.find((t: any) => t.id === id),
      update: async (_id: number, options: any) => { assert.equal(options.url, undefined); },
      reload: async (id: number) => { for (const fn of updated) fn(id, { status: "complete" }); },
      onUpdated: { addListener: (fn: any) => updated.add(fn), removeListener: (fn: any) => updated.delete(fn) },
      onRemoved: { addListener: noop }, onCreated: { addListener: noop } },
    scripting: { executeScript: async () => [{ result: await h.read() }] }
  };
  const context = vm.createContext({ chrome, URL, Date, AbortSignal, setTimeout, clearTimeout, navigator: { platform: "test" },
    fetch: async (address: string, options: any) => {
      const path = new URL(address).pathname;
      const body = JSON.parse(options.body || "{}"); h.posts.push({ path, body });
      const result = await h.request(path, body);
      return { ok: !result.status, status: result.status || 200, json: async () => result };
    } });
  vm.runInContext(fs.readFileSync("extension/service-worker.js", "utf8").replace('void initialize();', ''), context);
  h.run = (code: string) => vm.runInContext(code, context);
  h.state = () => saved;
  h.message = (message: any) => new Promise(resolve => listener(message, {}, resolve));
  return h;
}

test("tab identity includes price, category, pagination and domain; recovers changed tab id", () => {
  const h = harness();
  for (const changed of [url.replace("price_to=50", "price_from=500&p=2"), url + "&p=2", url.replace("/listing", "/kategoria/ksiazki"), url.replace("allegro.pl", "fakeallegro.pl")]) {
    assert.equal(h.run(`findMatchingTab([{id:1,url:${JSON.stringify(changed)}}],${JSON.stringify(watch)})`), null);
  }
  assert.equal(h.run(`findMatchingTab([{id:9,url:'https://allegro.pl/listing?price_to=50&string=mishima#x'}],${JSON.stringify(watch)}).id`), 9);
  assert.equal(h.run("isAllegroResultsPage('https://www.allegro.pl/listing')"), true);
});

test("navigation during extraction never submits results", async () => {
  const h = harness();
  h.read = async () => { h.tabs[0].url += "&p=2"; return { empty: true, listings: [], diagnostic: { url } }; };
  await assert.rejects(h.run(`checkOne(${JSON.stringify(watch)})`), /zmienił/);
  assert.equal(h.posts.length, 0);
});

test("checking preserves synchronized rename, pause, mute, addition and deletion", async () => {
  for (const remove of [false, true]) {
    const h = harness(); const reading = deferred(); const started = deferred();
    h.read = async () => { started.resolve(); await reading.promise; return { empty: true, listings: [], diagnostic: { url } }; };
    const checking = h.run("checkDue(1)"); await started.promise;
    h.request = async () => ({ monitors: [ ...(remove ? [] : [{ id: 1, name: "renamed", url, enabled: false, notificationsEnabled: false, intervalMinutes: 30 }]), { id: 2, name: "added", url: url + "&p=2", enabled: true }], notifications: [] });
    await h.run("reportPresence()");
    reading.resolve(); await checking;
    assert.equal(h.state().watched.length, remove ? 1 : 2);
    if (!remove) { assert.equal(h.state().watched[0].name, "renamed"); assert.equal(h.state().watched[0].enabled, false); assert.equal(h.state().watched[0].notificationsEnabled, false); }
    assert.equal(h.posts.filter((p: any) => p.path.endsWith("/results")).length, 0);
  }
});

test("lost ACK, restart and clear-unread retain deduplication", async () => {
  const event = { eventId: 7, title: "book", monitorName: "test" };
  const h = harness();
  h.request = async (path: string) => { if (path.endsWith("/ack")) throw Error("lost ACK"); return { monitors: [], notifications: [event], notificationBatch: "batch" }; };
  await assert.rejects(h.run("reportPresence()"), /lost ACK/);
  assert.equal(h.state().unread.length, 1);
  const restarted = harness(h.state());
  await restarted.message({ type: "clear-unread" });
  restarted.request = async () => ({ monitors: [], notifications: [event], notificationBatch: "batch" });
  await restarted.run("reportPresence()");
  assert.equal(restarted.state().unread.length, 0);
  assert.equal(restarted.notices.length, 0);
  assert.equal(restarted.posts.at(-1).body.batchId, "batch");
});

test("full local inbox does not acknowledge discarded events; clear interleaves with sync", async () => {
  const h = harness({ unread: Array.from({ length: 100 }, (_, i) => ({ eventId: i + 1 })), receivedThrough: 100 });
  h.request = async () => ({ monitors: [], notifications: [{ eventId: 101 }], notificationBatch: "batch" });
  await h.run("reportPresence()");
  assert.equal(h.posts.length, 1); assert.equal(h.state().receivedThrough, 100);
  const waiting = deferred(); const started = deferred();
  h.request = async () => { started.resolve(); await waiting.promise; return { monitors: [], notifications: [{ eventId: 101 }], notificationBatch: "batch" }; };
  const sync = h.run("reportPresence()"); await started.promise;
  await h.message({ type: "clear-unread" }); waiting.resolve(); await sync;
  assert.equal(h.state().unread.length, 1); assert.equal(h.state().receivedThrough, 101);
});

test("parallel syncs serialize and network/auth failures preserve monitors and report errors", async () => {
  const h = harness(); const waiting = deferred(); const started = deferred(); let count = 0;
  h.request = async () => { count++; started.resolve(); await waiting.promise; return { monitors: [{ id: 1, url }], notifications: [] }; };
  const first = h.run("reportPresence()"); await started.promise;
  const second = h.run("reportPresence()"); await Promise.resolve(); assert.equal(count, 1);
  waiting.resolve(); await Promise.all([first, second]); assert.equal(count, 2);
  assert.ok(h.state().lastSyncAt);
  h.request = async () => { throw Error("offline"); };
  assert.equal((await h.message({ type: "sync" })).ok, false); assert.equal(h.state().connection, "offline"); assert.equal(h.state().watched.length, 1);
  h.request = async () => ({ status: 401 });
  assert.equal((await h.message({ type: "sync" })).ok, false); assert.equal(h.state().connection, "unauthorized");
});

test("adding a monitor during an outstanding sync is serialized without losing the addition", async () => {
  const h = harness(); const waiting = deferred(); const started = deferred();
  h.request = async (path: string) => {
    if (path.endsWith("/presence")) { started.resolve(); await waiting.promise; return { monitors: [{ id: 1, url, name: "synced" }], notifications: [] }; }
    return { id: 2, name: "new" };
  };
  const sync = h.run("reportPresence()"); await started.promise;
  h.tabs = [{ id: 2, url: url + "&p=2" }];
  const add = h.run("addCurrentTab('new', 5)");
  await Promise.resolve(); assert.equal(h.posts.length, 1);
  waiting.resolve(); await Promise.all([sync, add]);
  assert.equal(h.state().watched.length, 2); assert.equal(h.state().watched[0].name, "synced"); assert.equal(h.state().watched[1].monitorId, 2);
});
