import { ThinClient } from "./bridge/thin-client";

const sock = process.env.HERDR_CLIENT_SOCK ?? "/tmp/herdr-client-remote.sock";
const termId = process.argv[2] ?? "term_654d49b9d7537e";
const cols = Number(process.argv[3] ?? 100);
const rows = Number(process.argv[4] ?? 30);
const protocol = Number(process.env.HERDR_PROTOCOL ?? 16);

const c = new ThinClient(sock, async () => protocol);
c.on("welcome", (w) => console.log("WELCOME", JSON.stringify(w)));
c.on("error", (e) => console.log("ERROR", (e as Error).message));
c.on("close", () => console.log("CLOSED"));

let termFrames = 0;
c.on("terminal", (t) => {
  termFrames++;
  if (termFrames > 2) return;
  const text = t.bytes.toString("utf8");
  console.log(
    `TERMINAL #${termFrames} ${t.width}x${t.height} full=${t.full} bytes=${t.bytes.length}`,
  );
  console.log("  --- begin ---");
  console.log(text.slice(0, 600));
  console.log("  --- end ---");
});
c.on("frame", (f) => console.log(`FRAME ${f.width}x${f.height}`));

await c.connect(cols, rows, { launchMode: "terminal-attach", encoding: 1 }); // TerminalAttach + TerminalAnsi
setTimeout(() => {
  console.log("attaching to", termId);
  c.attach(termId);
}, 400);

setTimeout(() => {
  console.log("done, terminal frames:", termFrames);
  c.close();
  process.exit(0);
}, 5000);
