import assert from "node:assert/strict";
import test from "node:test";
import formbody from "@fastify/formbody";
import Fastify from "fastify";

test("accepts form submissions used by the monitor GUI", async () => {
  const app = Fastify();
  await app.register(formbody);
  app.post<{ Body: { name: string; url: string; intervalMinutes: string } }>("/monitors", async request => request.body);

  const response = await app.inject({
    method: "POST",
    url: "/monitors",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: "name=Yukio+Mishima&url=https%3A%2F%2Fallegro.pl%2Flisting%3Fstring%3Dyukio%2520mishima&intervalMinutes=10"
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    name: "Yukio Mishima",
    url: "https://allegro.pl/listing?string=yukio%20mishima",
    intervalMinutes: "10"
  });
  await app.close();
});
