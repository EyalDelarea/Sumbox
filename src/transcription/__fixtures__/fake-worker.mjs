// Deterministic stand-in for worker.py. No model, no ffmpeg.
// Emits {ready:true}, then per request: {text:...} unless the path contains
// "bad", in which case {error:...}.
process.stdout.write(JSON.stringify({ ready: true }) + "\n");

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!line.trim()) continue;
    const req = JSON.parse(line);
    if (String(req.wavPath).includes("bad")) {
      process.stdout.write(JSON.stringify({ error: "boom" }) + "\n");
    } else {
      process.stdout.write(JSON.stringify({ text: "שלום עולם" }) + "\n");
    }
  }
});
