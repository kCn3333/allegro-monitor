import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const execute = promisify(execFile);

async function until(predicate: () => Promise<boolean> | boolean, diagnostic: () => string) {
  const deadline = Date.now() + 15_000;
  do {
    if (await predicate()) return;
    await delay(50);
  } while (Date.now() < deadline);
  assert.fail(diagnostic());
}

async function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "allegro-runtime-"));
  let child: ChildProcess | undefined;
  let output = "";
  const serverPids = () =>
    [...output.matchAll(/"pid":(\d+).*"msg":"Server listening at /g)].map((match) => Number(match[1]));
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      return false;
    }
  };
  const signal = (value: NodeJS.Signals) => {
    if (!child?.pid) return;
    try {
      // Only this fixture's dedicated process group: npm, its watcher and the application.
      process.kill(-child.pid, value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  async function stop() {
    if (!child) return;
    signal("SIGTERM");
    try {
      await until(
        () => (child!.exitCode !== null || child!.signalCode !== null) && serverPids().every((pid) => !alive(pid)),
        () => `Application did not shut down:\n${output}`,
      );
    } finally {
      signal("SIGKILL");
    }
    child = undefined;
  }
  t.after(async () => {
    try {
      await stop();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  // Copy only tracked application inputs, never a real .env or database.
  for (const name of ["package.json", "tsconfig.json", "src", "public", "extension"])
    fs.cpSync(name, path.join(directory, name), { recursive: true });
  fs.symlinkSync(path.resolve("node_modules"), path.join(directory, "node_modules"), "dir");
  const reservation = net.createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => reservation.close((error) => (error ? reject(error) : resolve())));
  const env = {
    ...process.env,
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ""}`,
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: String(port),
    DATABASE_PATH: path.join(directory, "test.sqlite"),
    EXTENSION_DIRECTORY: path.join(directory, "extension"),
    APP_PUBLIC_URL: "",
    APP_USERNAME: "",
    APP_PASSWORD: "",
    APP_SESSION_SECRET: "runtime-smoke-test-only-secret",
    APP_TIME_ZONE: "Europe/Warsaw",
    TRUST_PROXY: "",
    TELEGRAM_BOT_TOKEN: "",
    TELEGRAM_CHAT_IDS: "",
    TELEGRAM_CHAT_ID: "",
  };
  const healthy = async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
      return response.ok && ((await response.json()) as { status: string }).status === "ok";
    } catch {
      return false;
    }
  };
  return {
    directory,
    serverPids,
    healthy,
    stop,
    build: () => execute("npm", ["run", "build"], { cwd: directory, env, timeout: 45_000 }),
    async start(script: "dev" | "start") {
      child = spawn("npm", ["run", script], { cwd: directory, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout!.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr!.on("data", (chunk) => {
        output += chunk;
      });
      await until(
        () => serverPids().length > 0 && healthy(),
        () => `${script} failed to start on ${process.version}:\n${output}`,
      );
    },
    restarted: () =>
      until(
        () => serverPids().length >= 2 && healthy(),
        () => `Watcher did not restart:\n${output}`,
      ),
  };
}

test("npm run dev starts, serves health, restarts after a watched edit and shuts down", {
  timeout: 60_000,
}, async (t) => {
  const app = await fixture(t);
  await app.start("dev");
  const firstPid = app.serverPids()[0];
  fs.appendFileSync(path.join(app.directory, "src/main.ts"), "\n// Isolated watcher restart probe.\n");
  await app.restarted();
  assert.notEqual(app.serverPids().at(-1), firstPid, "watch mode must start a new application process");
  await app.stop();
  assert.equal(await app.healthy(), false);
});

test("npm run build and npm start serve health and shut down", { timeout: 75_000 }, async (t) => {
  const app = await fixture(t);
  await app.build();
  await app.start("start");
  await app.stop();
  assert.equal(await app.healthy(), false);
});
