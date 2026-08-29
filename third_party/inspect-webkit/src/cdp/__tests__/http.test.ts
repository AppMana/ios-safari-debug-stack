import { expect, test } from "bun:test";
import * as http from "node:http";
import { listen } from "../http";

test("CDP HTTP server rejects a non-loopback bind", async () => {
  const server = http.createServer();
  await expect(listen(server, "0.0.0.0", 0)).rejects.toThrow(
    "refusing non-loopback CDP host",
  );
  server.close();
});
