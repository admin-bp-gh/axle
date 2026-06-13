// child.js - boots one server entry (pre or post) with stubs installed, rebinds the
// listener to an ephemeral loopback port and prints HARNESS_PORT=<n> for the runner.
// env: HARNESS_ENTRY (abs path to server.js), AXLE_DB, HARNESS_GATE, action/CSRF envs.
"use strict";
const path = require("path");
const { NM } = require("./stubs.js"); // installs the interceptor as a side effect

const express = require(path.join(NM, "express")); // same instance the entry will get
const origListen = express.application.listen;
express.application.listen = function (...args) {
  const cb = typeof args[args.length - 1] === "function" ? args[args.length - 1] : null;
  const srv = origListen.call(this, 0, "127.0.0.1", function () {
    console.log("HARNESS_PORT=" + srv.address().port);
    if (cb) cb();
  });
  return srv;
};

require(process.env.HARNESS_ENTRY);
