// logrotate-tee.js - size-based rotating logger for the Axle server.
//
// Reads the server's merged stdout+stderr on stdin and appends it to server.log. When the
// live log reaches AXLE_LOG_MAX_BYTES it is rotated: server.log.<KEEP> is dropped,
// server.log.<n> shifts to .<n+1>, server.log becomes server.log.1, and a fresh server.log
// is opened. Keeps AXLE_LOG_KEEP rotated files.
//
// Why a tee (and not rename/truncate the live log): under the old wrapper, cmd.exe's `>>`
// redirect held server.log open for node's whole run, and Windows won't let you rename or
// truncate a file held open like that. This process is itself the writer, so it owns the
// handle and can rotate with a clean close -> rename -> reopen. Wired in by run-server.ps1:
//     node ... server.js 2>&1 | node logrotate-tee.js
//
// It lives and dies with each server run (stdin EOF = the server exited) and is deliberately
// defensive: any rotation/write error is reported to stderr but never throws out of the write
// path, so the server's output always has somewhere to land.

const fs = require("fs");
const path = require("path");

const LOG  = process.env.AXLE_LOG            || "C:\\Axle\\logs\\server.log";
const MAX  = parseInt(process.env.AXLE_LOG_MAX_BYTES || String(100 * 1024 * 1024), 10); // 100 MB
const KEEP = parseInt(process.env.AXLE_LOG_KEEP      || "10", 10);                       // .1 .. .10

fs.mkdirSync(path.dirname(LOG), { recursive: true });

let fd = fs.openSync(LOG, "a");
let size = fs.statSync(LOG).size; // continue counting from whatever is already there

function rotate() {
  fs.closeSync(fd);
  try { fs.rmSync(`${LOG}.${KEEP}`, { force: true }); } catch {}     // drop the oldest
  for (let i = KEEP - 1; i >= 1; i--) {                              // shift the rest up
    const from = `${LOG}.${i}`;
    if (fs.existsSync(from)) { try { fs.renameSync(from, `${LOG}.${i + 1}`); } catch {} }
  }
  try { fs.renameSync(LOG, `${LOG}.1`); } catch {}                   // live -> .1
  fd = fs.openSync(LOG, "a");                                        // fresh live log
  size = 0;
}

function write(chunk) {
  try {
    // Fill the current log up to MAX, rotate, and continue with the remainder. Splitting at
    // the boundary keeps each file strictly <= MAX regardless of how big a single write is
    // (a burst can't blow past the cap), and makes rotation independent of pipe chunking.
    let off = 0;
    while (off < chunk.length) {
      if (size >= MAX) rotate();                       // current file is full
      const end = Math.min(off + (MAX - size), chunk.length);
      const slice = chunk.subarray(off, end);
      fs.writeSync(fd, slice);                         // synchronous: nothing buffered to lose
      size += slice.length;
      off = end;
    }
  } catch (e) {
    try { process.stderr.write(`logrotate-tee: write error: ${e && e.message}\n`); } catch {}
  }
}

process.stdin.on("data", write);
process.stdin.on("end",   () => { try { fs.closeSync(fd); } catch {} process.exit(0); });
process.stdin.on("error", () => { try { fs.closeSync(fd); } catch {} process.exit(0); });
