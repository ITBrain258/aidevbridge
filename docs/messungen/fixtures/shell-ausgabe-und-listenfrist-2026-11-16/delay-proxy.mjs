// Delays every chunk of a TCP connection by a fixed time per direction.
// It listens on 127.0.0.1 only and changes nothing on the target.
//
//   node delay-proxy.mjs <listen port> <target host> <target port> <delay ms> <control dir>
//
// While the file <control dir>/stall exists, nothing is passed on in either
// direction. The proxy ends when <control dir>/stop appears.
import { createConnection, createServer } from "node:net";
import { existsSync } from "node:fs";
import { join } from "node:path";

const [listenPort, targetHost, targetPort, delayText, control] = process.argv.slice(2);
const delay = Number(delayText);
const stall = join(control, "stall");
const stop = join(control, "stop");

function pipe(from, to) {
  from.on("data", (chunk) => {
    setTimeout(() => {
      if (existsSync(stall) || to.destroyed) return;
      to.write(chunk);
    }, delay);
  });
  from.on("end", () => setTimeout(() => to.end(), delay));
  from.on("error", () => to.destroy());
  from.on("close", () => setTimeout(() => to.destroy(), delay));
}

const server = createServer((client) => {
  const target = createConnection({ host: targetHost, port: Number(targetPort) });
  client.setNoDelay(true);
  target.setNoDelay(true);
  pipe(client, target);
  pipe(target, client);
});
server.listen(Number(listenPort), "127.0.0.1", () => {
  console.log(`listening on 127.0.0.1:${listenPort}, ${delay} ms per direction`);
});
const watch = setInterval(() => {
  if (!existsSync(stop)) return;
  clearInterval(watch);
  server.close();
  process.exit(0);
}, 500);
