import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import fs from "node:fs";
import { randomUUID } from "node:crypto";

const url = "https://allegro.pl/listing?string=mishima&price_to=50";
const watch = { monitorId: 1, name: "old", url, tabId: 1, enabled: true, intervalMinutes: 5, nextCheckAt: 0 };
const extensionId = "abcdefghijklmnopabcdefghijklmnop";
const popupSender = { id: extensionId, url: `chrome-extension://${extensionId}/popup.html`, origin: `chrome-extension://${extensionId}` };
function deferred() { let resolve!: (value?: any) => void; const promise = new Promise<any>(r => { resolve = r; }); return { promise, resolve }; }
function harness(initial: any = {}) {
  let saved: any = { token: "test", watched: [{ ...watch }], unread: [], receivedThrough: 0, ...initial };
  let listener: any;
  const updated = new Set<any>();
  const h: any = { tabs: [{ id: 1, url }], posts: [], notices: [], reloads: [], effects: [], now: 1000000,
    load: async () => {}, highlight: async () => {}, beforeWrite: async (_patch: any) => {},
    request: async () => ({ monitors: [], notifications: [] }), read: async () => ({ empty: true, listings: [], diagnostic: { url } }) };
  const noop = () => {};
  const chrome = {
    storage: { local: { get: async (defaults: any) => { h.effects.push("storage.get"); return structuredClone({ ...defaults, ...saved }); }, set: async (patch: any) => { h.effects.push("storage.set"); await h.beforeWrite(patch); saved = structuredClone({ ...saved, ...patch }); } } },
    alarms: { get: async () => true, onAlarm: { addListener: noop } },
    action: { setBadgeBackgroundColor: async () => { h.effects.push("action.setBadgeBackgroundColor"); }, setBadgeText: async () => { h.effects.push("action.setBadgeText"); } },
    runtime: { id: extensionId, onInstalled: { addListener: noop }, onStartup: { addListener: noop }, onMessage: { addListener: (fn: any) => { listener = fn; } } },
    notifications: { create: async (...args: any[]) => h.notices.push(args) },
    tabs: { query: async () => { h.effects.push("tabs.query"); return structuredClone(h.tabs); }, get: async (id: number) => { h.effects.push("tabs.get"); return h.tabs.find((t: any) => t.id === id); },
      update: async (_id: number, options: any) => { h.effects.push("tabs.update"); assert.equal(options.url, undefined); },
      reload: async (id: number) => { h.effects.push("tabs.reload"); h.reloads.push(id); await h.load(); for (const fn of updated) fn(id, { status: "complete" }); },
      onUpdated: { addListener: (fn: any) => updated.add(fn), removeListener: (fn: any) => updated.delete(fn) },
      onRemoved: { addListener: noop }, onCreated: { addListener: noop } },
    scripting: { executeScript: async ({ func }: any) => { h.effects.push("scripting.executeScript"); return [{ result: await (func.name === "markNewOffers" ? h.highlight() : h.read()) }]; } }
  };
  class Clock extends Date { static now() { return h.now; } }
  let timerId = 0;
  const timers = new Map<number, () => void>();
  const setTimer = (fn: () => void, delay: number) => {
    const id = ++timerId; timers.set(id, fn);
    // Pacing between monitors is irrelevant to scheduling assertions; no wall-clock waits.
    if (delay >= 12000 && delay <= 22000) queueMicrotask(() => { if (timers.delete(id)) fn(); });
    return id;
  };
  const context = vm.createContext({ BACKEND_URL: "https://monitor.example", chrome, URL, Date: Clock, crypto: { randomUUID }, AbortSignal,
    setTimeout: setTimer, clearTimeout: (id: number) => timers.delete(id), navigator: { platform: "test" },
    fetch: async (address: string, options: any) => {
      const path = new URL(address).pathname;
      const body = JSON.parse(options.body || "{}"); h.posts.push({ path, body });
      const result = await h.request(path, body);
      return { ok: !result.status, status: result.status || 200, json: async () => result };
    } });
  vm.runInContext(fs.readFileSync("extension/service-worker.js", "utf8").replace(/^import .*backend-config\.js.*;\n/m, "").replace(/\nvoid initialize\(\);\s*$/, ''), context);
  h.run = (code: string) => vm.runInContext(code, context);
  h.state = () => saved;
  h.deliver = (message: any, sender: any) => {
    let keepAlive: boolean | undefined;
    const responses: any[] = [];
    const response = new Promise(resolve => { keepAlive = listener(message, sender, (result: any) => {
      const copy = structuredClone(result); responses.push(copy); resolve(copy);
    }); });
    return { keepAlive, response, responses };
  };
  h.message = (message: any) => h.deliver(message, popupSender).response;
  return h;
}

const popupOperations = [
  { type: "pair", code: "ABCD-1234" },
  { type: "sync" },
  { type: "add-current", name: "Added", intervalMinutes: 15 },
  { type: "check", monitorId: 1 },
  { type: "notification-state", monitorId: 1, enabled: false },
  { type: "snooze-notifications", enabled: true, duration: "hour" },
  { type: "clear-unread" }
];

for (const message of popupOperations) {
  test(`own popup sender can ${message.type} with an asynchronous response`, async () => {
    const h = harness({ backendUrl: "https://monitor.example", token: "existing-token",
      unread: [{ eventId: 7, title: "Unread" }], receivedThrough: 7 });
    let notificationsEnabled = true;
    h.request = async (path: string, body: any) => {
      if (path.endsWith("/pair")) return { token: "replacement-token" };
      if (path === "/api/extension/monitors") return { id: 2, name: "Added" };
      if (path.endsWith("/notification-state")) notificationsEnabled = body.enabled;
      return { monitors: [{ id: 1, name: "Synced", url, enabled: true, intervalMinutes: 5, notificationsEnabled }], notifications: [] };
    };
    const delivery = h.deliver(message, popupSender);
    assert.equal(delivery.keepAlive, true);
    assert.deepEqual(delivery.responses, [], "valid operations respond after the listener returns");
    const response = await delivery.response;
    assert.deepEqual(response, { ok: true, result: message.type === "add-current" ? { id: 2, name: "Added" } : true });
    assert.equal(delivery.responses.length, 1);
    assert.equal(h.state().token, message.type === "pair" ? "replacement-token" : "existing-token");
    if (message.type === "pair") {
      assert.equal(h.posts[0].path, "/api/extension/pair");
      assert.equal(h.posts[0].body.code, message.code);
      assert.equal(h.state().watched[0].monitorId, 1, "same-server pairing preserves monitors");
    }
    if (message.type === "sync") {
      assert.equal(h.posts[0].path, "/api/extension/presence");
      assert.equal(h.state().watched[0].name, "Synced");
    }
    if (message.type === "add-current") {
      assert.deepEqual(h.posts[0], { path: "/api/extension/monitors", body: { name: "Added", url, intervalMinutes: 15 } });
      assert.equal(h.state().watched[0].monitorId, 2);
    }
    if (message.type === "check") {
      assert.deepEqual(h.reloads, [1]);
      assert.ok(h.posts.some((post: any) => post.path === "/api/extension/monitors/1/results"));
    }
    if (message.type === "notification-state") {
      assert.equal(h.posts[0].path, "/api/extension/monitors/1/notification-state");
      assert.deepEqual(h.posts[0].body, { enabled: false });
      assert.equal(h.state().watched[0].notificationsEnabled, false);
    }
    if (message.type === "clear-unread") {
      assert.deepEqual(h.state().unread, []);
      assert.equal(h.state().receivedThrough, 7);
      assert.deepEqual(h.posts, []);
    }
    if (message.type === "snooze-notifications") {
      assert.deepEqual(h.state().notificationSnooze, { duration: "hour", until: h.now + 3600_000 });
      assert.deepEqual(h.posts, []);
    }
  });

  test(`foreign or missing popup sender cannot ${message.type} or cause side effects`, async () => {
    for (const sender of [{ ...popupSender, id: "ponmlkjihgfedcbaponmlkjihgfedcba" },
      { url: popupSender.url, origin: popupSender.origin }, { id: "" }, { id: null }, undefined, null]) {
      const h = harness({ backendUrl: "https://monitor.example", unread: [{ eventId: 7 }], receivedThrough: 7 });
      const before = structuredClone(h.state());
      const delivery = h.deliver(message, sender);
      assert.equal(delivery.keepAlive, false);
      assert.deepEqual(await delivery.response, { ok: false, error: "Nieprawidłowy nadawca wiadomości" });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(delivery.responses.length, 1);
      assert.deepEqual(h.state(), before);
      assert.deepEqual(h.posts, []);
      assert.deepEqual(h.effects, [], "no storage access, badge updates, tab operations or script injection");
      assert.deepEqual(h.notices, []);
      assert.deepEqual(h.reloads, []);
    }
  });
}

for (const [duration, milliseconds] of [["hour", 3600_000], ["day", 86400_000]] as const) {
  test(`notification snooze for ${duration} survives restart, keeps checks and ACK active and expires at its deadline`, async () => {
    let h = harness();
    assert.equal((await h.message({ type: "snooze-notifications", enabled: true, duration })).ok, true);
    const deadline = h.now + milliseconds;
    assert.equal(h.state().notificationSnooze.until, deadline);
    const snapshot = structuredClone(h.state());
    h = harness(snapshot);
    let eventId = 1;
    h.request = async (path: string) => path.endsWith("/presence")
      ? { monitors: [{ id: 1, ...watch }], notifications: [{ eventId, monitorName: "Book", title: `Offer ${eventId}` }], notificationBatch: `batch-${eventId}` }
      : {};
    h.now = deadline - 1;
    assert.equal((await h.message({ type: "check", monitorId: 1 })).ok, true);
    assert.deepEqual(h.reloads, [1]);
    assert.ok(h.posts.some((post: any) => post.path.endsWith("/results")));
    assert.ok(h.posts.some((post: any) => post.path.endsWith("/ack")));
    assert.equal(h.state().unread.length, 1);
    assert.equal(h.state().receivedThrough, 1);
    assert.deepEqual(h.notices, []);
    h.now = deadline;
    eventId = 2;
    await h.message({ type: "sync" });
    assert.equal(h.notices.length, 1);
    assert.equal(h.notices[0][0], "event-2");
    assert.equal(h.state().unread.length, 2, "muted offers remain in the new-offer list");
    await h.message({ type: "sync" });
    assert.equal(h.notices.length, 1, "expiry does not replay earlier offers");
  });
}

test("indefinite snooze persists until disabled and also suppresses blocked-tab notices", async () => {
  let h = harness();
  await h.message({ type: "snooze-notifications", enabled: true, duration: "forever" });
  h = harness(structuredClone(h.state()));
  h.now += 365 * 86400_000;
  assert.equal(await h.run("browserNotificationsPaused()"), true);
  h.read = async () => ({ blocked: true });
  await assert.rejects(h.run(`checkOne(${JSON.stringify(watch)})`), /Captcha/);
  assert.deepEqual(h.notices, []);
  await h.message({ type: "snooze-notifications", enabled: false, duration: "forever" });
  assert.equal(await h.run("browserNotificationsPaused()"), false);
  await assert.rejects(h.run(`checkOne(${JSON.stringify(watch)})`), /Captcha/);
  assert.equal(h.notices.length, 1);
  assert.equal(h.state().token, "test");
  assert.equal(h.state().watched[0].enabled, true);
});

test("invalid snooze settings are rejected without changing storage or contacting the backend", async () => {
  for (const payload of [{ enabled: "true", duration: "hour" }, { enabled: true, duration: "week" }, { enabled: true }, { duration: "day" }]) {
    const h = harness();
    const before = structuredClone(h.state());
    assert.equal((await h.message({ type: "snooze-notifications", ...payload })).ok, false);
    assert.deepEqual(h.state(), before);
    assert.deepEqual(h.effects, []);
    assert.deepEqual(h.posts, []);
  }
});

test("sender validation precedes even reading the requested operation", async () => {
  const h = harness();
  const message = Object.defineProperty({}, "type", { get() { throw Error("Operation accessed before authorization"); } });
  const response = await h.deliver(message, { id: "foreign" }).response;
  assert.deepEqual(response, { ok: false, error: "Nieprawidłowy nadawca wiadomości" });
  assert.deepEqual(h.effects, []);
});

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

test("captcha persists backoff before stopping; restart/alarm skips it but checks another due monitor", async () => {
  const h = harness({ watched: [{ ...watch }, { ...watch, monitorId: 2, tabId: 2, url: url + "&p=2" }] });
  h.tabs.push({ id: 2, url: url + "&p=2" });
  h.read = async () => ({ blocked: true });
  h.request = async () => { throw Error("error endpoint unavailable"); };
  await h.run("checkDue()");
  assert.equal(h.state().watched[0].nextCheckAt, h.now + 600000);
  assert.equal(h.state().watched[0].attemptId, null);
  assert.deepEqual(h.reloads, [1]);
  const restarted = harness(h.state()); restarted.now = h.now + 60000;
  restarted.tabs = h.tabs;
  restarted.read = async () => ({ empty: true, listings: [], diagnostic: { url: url + "&p=2" } });
  // tick uses the same path as the alarm. Failed presence preserves local monitors.
  restarted.request = async (path: string) => { if (path.endsWith("/presence")) throw Error("offline"); return {}; };
  await restarted.run("tick()"); assert.deepEqual(restarted.reloads, [2]);
  assert.equal(restarted.state().watched[0].nextCheckAt, h.now + 600000);
});

test("manual error persists current interval before returning popup error, even if error reporting fails", async () => {
  const h = harness();
  h.request = async (path: string) => {
    if (path.endsWith("/presence")) return { monitors: [{ id: 1, ...watch }], notifications: [] };
    assert.equal(h.state().watched[0].nextCheckAt, h.now + 1800000);
    throw Error("backend unavailable");
  };
  h.read = async () => {
    await h.run("mutateState(s => ({watched:s.watched.map(w => ({...w,intervalMinutes:30,name:'updated'}))}))");
    throw Error("read failed");
  };
  const result = await h.message({ type: "check", monitorId: 1 });
  assert.equal(result.ok, false); assert.match(result.error, /read failed/);
  assert.equal(h.state().watched[0].nextCheckAt, h.now + 1800000);
  assert.equal(h.state().watched[0].name, "updated");
  const restarted = harness(h.state()); restarted.now += 60000;
  await restarted.run("checkDue()"); assert.equal(restarted.reloads.length, 0);
});

test("interruption during load or backend response persists a bounded lease and recovers once it expires", async () => {
  for (const stage of ["load", "backend"]) {
    const h = harness(); const started = deferred();
    const never = new Promise(() => {});
    if (stage === "load") h.load = async () => { started.resolve(); return never; };
    else h.request = async () => { started.resolve(); return never; }; // includes accepted result with lost response
    void h.run("checkDue(1)"); await started.promise;
    const persisted = h.state(); assert.ok(persisted.watched[0].attemptId);
    assert.equal(persisted.watched[0].attemptUntil, h.now + 600000);
    const restarted = harness(persisted); restarted.now = h.now + 599999;
    await restarted.run("checkDue()"); assert.equal(restarted.reloads.length, 0);
    await assert.rejects(restarted.run("checkDue(1)"), /Próba w toku/);
    restarted.now += 1; await restarted.run("checkDue()");
    assert.deepEqual(restarted.reloads, [1]); assert.equal(restarted.state().watched[0].attemptId, null);
    assert.equal(restarted.state().watched[0].nextCheckAt, restarted.now + 300000);
  }
});

test("accepted results persist success before auxiliary work; auxiliary failures never report a failed check", async () => {
  for (const fail of ["highlight", "presence"]) {
    const h = harness();
    h.request = async (path: string) => {
      if (path.endsWith("/results")) return { newListings: [{ externalId: "offer:1" }] };
      if (path.endsWith("/presence")) throw Error("presence failed");
      throw Error("unexpected error reporting");
    };
    h.highlight = async () => {
      assert.equal(h.state().watched[0].nextCheckAt, h.now + 300000);
      assert.equal(h.state().watched[0].attemptId, null);
      if (fail === "highlight") throw Error("tab closed");
    };
    await h.run("checkDue(1)");
    assert.equal(h.posts.some((p: any) => p.path.endsWith("/error")), false);
    const restarted = harness(h.state()); restarted.now += 60000;
    await restarted.run("checkDue()"); assert.equal(restarted.reloads.length, 0);
  }
});

test("restart during auxiliary work keeps successful schedule; old completion cannot overwrite a newer attempt", async () => {
  const h = harness(); const started = deferred();
  h.request = async () => ({ newListings: [{ externalId: "offer:1" }] });
  h.highlight = async () => { started.resolve(); return new Promise(() => {}); };
  void h.run("checkDue(1)"); await started.promise;
  const restarted = harness(h.state()); restarted.now += 60000;
  await restarted.run("checkDue()"); assert.equal(restarted.reloads.length, 0);
  const old = await restarted.run("(async () => beginAttempt((await state()).watched[0], true))()");
  restarted.now += 600000;
  const newer = await restarted.run("(async () => beginAttempt((await state()).watched[0], true))()");
  await restarted.run(`finishAttempt(${JSON.stringify(old)}, true)`);
  assert.equal(restarted.state().watched[0].attemptId, newer.attemptId);
});

test("interruption after backend acceptance but before local completion retains the recovery deadline", async () => {
  const h = harness(); const started = deferred(); let accepted = false;
  h.request = async () => { accepted = true; return {}; };
  h.beforeWrite = async (patch: any) => {
    if (accepted && patch.watched?.[0].attemptId === null) { started.resolve(); await new Promise(() => {}); }
  };
  void h.run("checkDue(1)"); await started.promise;
  assert.equal(accepted, true); assert.ok(h.state().watched[0].attemptId);
  const restarted = harness(h.state()); restarted.now += 60000;
  await restarted.run("checkDue()"); assert.equal(restarted.reloads.length, 0);
  restarted.now += 540000; await restarted.run("checkDue()"); assert.deepEqual(restarted.reloads, [1]);
});

test("failing old attempt does not restore deletion or overwrite changed URL and schedule", async () => {
  for (const remove of [false, true]) {
    const h = harness(); const started = deferred(); const waiting = deferred();
    h.read = async () => { started.resolve(); await waiting.promise; throw Error("read failed"); };
    const checking = h.run("checkDue(1)"); await started.promise;
    await h.run(remove ? "mutateState(() => ({watched:[]}))"
      : "mutateState(s => ({watched:s.watched.map(w => ({...w,url:w.url+'&p=3',name:'changed',enabled:false,notificationsEnabled:false,nextCheckAt:9000000}))}))");
    waiting.resolve(); await assert.rejects(checking, /read failed/);
    assert.equal(h.state().watched.length, remove ? 0 : 1);
    if (!remove) {
      assert.equal(h.state().watched[0].nextCheckAt, 9000000);
      assert.equal(h.state().watched[0].enabled, false); assert.equal(h.state().watched[0].notificationsEnabled, false);
    }
  }
});

test("each completed attempt finishes exactly once, before reporting a failure", async () => {
  for (const failed of [false, true]) {
    const h = harness();
    h.run("globalThis.finishes = 0; const originalFinish = finishAttempt; finishAttempt = async (...args) => { finishes++; return originalFinish(...args); }");
    if (failed) h.read = async () => { throw Error("read failed"); };
    h.request = async (path: string) => {
      if (path.endsWith("/error")) assert.equal(h.run("finishes"), 1);
      return {};
    };
    if (failed) await assert.rejects(h.run("checkDue(1)"), /read failed/);
    else await h.run("checkDue(1)");
    assert.equal(h.run("finishes"), 1);
  }
});

test("a changed packaged backend never receives the previous server token", async () => {
  const h = harness({ backendUrl: "https://previous.example" });
  await assert.rejects(h.run("reportPresence()"), /Adres serwera zmienił/);
  assert.equal(h.posts.length, 0);
  assert.equal(h.state().connection, "unauthorized");
  assert.equal(h.state().token, "test");
});

test("pairing uses packaged configuration and clears monitors only when switching servers", async () => {
  for (const backendUrl of ["https://previous.example", "https://monitor.example"]) {
    const h = harness({ backendUrl });
    h.request = async () => ({ token: "replacement-token" });
    const result = await h.message({ type: "pair", code: "ABCD-1234", backendUrl: "https://ignored.example" });
    assert.equal(result.ok, true);
    assert.equal(h.state().backendUrl, "https://monitor.example");
    assert.equal(h.state().token, "replacement-token");
    assert.equal(h.state().watched.length, backendUrl === "https://monitor.example" ? 1 : 0);
  }
});

test("presence reports device metadata and tolerates unavailable platform hints", async () => {
  const h = harness();
  h.run(`chrome.runtime.getManifest=()=>({version:'1.1.4'});chrome.runtime.getPlatformInfo=async()=>({os:'linux',arch:'x86-64'});navigator.userAgentData={platform:'Linux',getHighEntropyValues:async()=>({platformVersion:'',fullVersionList:[{brand:'Not A Brand',version:'99'},{brand:'Chromium',version:'140.0'}]})}`);
  await h.run("reportPresence()");
  assert.deepEqual(h.posts.find((post: any) => post.path.endsWith("/presence")).body.device, {
    extensionVersion: "1.1.4", browser: "Chromium 140.0", os: "Linux", osVersion: null, arch: "x86-64"
  });
  h.run(`chrome.runtime.getPlatformInfo=async()=>{throw new Error('unavailable')};navigator.userAgentData.getHighEntropyValues=async()=>{throw new Error('denied')}`);
  await h.run("reportPresence()");
  assert.equal(h.posts.at(-1).body.device.osVersion, null);
  assert.equal(h.posts.at(-1).body.device.extensionVersion, "1.1.4");
});
