import type { FastifyInstance } from "fastify";
import { renderExtension } from "../extension-page.js";

interface ExtensionPageRouteDependencies {
  latestExtensionVersion: string;
  extensionPackage: Buffer | null;
}

export function registerExtensionPageRoutes(
  app: FastifyInstance,
  { latestExtensionVersion, extensionPackage }: ExtensionPageRouteDependencies,
): void {
  app.get("/extension", async (_request, reply) =>
    reply.type("text/html; charset=utf-8").send(renderExtension(latestExtensionVersion)),
  );

  app.get("/extension/download", async (_request, reply) => {
    if (!extensionPackage) return reply.code(503).send("Ustaw APP_PUBLIC_URL, aby pobrać rozszerzenie");
    return reply
      .header("Content-Disposition", 'attachment; filename="allegro-monitor-extension.zip"')
      .type("application/zip")
      .send(extensionPackage);
  });
}
