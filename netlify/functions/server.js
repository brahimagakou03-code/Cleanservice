"use strict";

/* Référence statique pour que le bundle Netlify inclue le moteur de vues. */
require("ejs");

const serverless = require("serverless-http");
const { app } = require("../../src/app");

const slsHandler = serverless(app);

function bodyByteLength(event) {
  if (event.body == null) return 0;
  if (Buffer.isBuffer(event.body)) return event.body.length;
  if (typeof event.body === "string") {
    return event.isBase64Encoded
      ? Buffer.from(event.body, "base64").length
      : Buffer.byteLength(event.body, "utf8");
  }
  return 0;
}

/** Content-Length: 0 avec corps non vide empêche le parsing du flux côté Express. */
function stripZeroContentLengthIfBodyPresent(event) {
  const len = bodyByteLength(event);
  if (len === 0) return;

  const strip = (headers) => {
    if (!headers || typeof headers !== "object") return;
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() !== "content-length") continue;
      const v = headers[key];
      const n = Array.isArray(v) ? Number(v[0]) : Number(v);
      if (Number.isFinite(n) && n === 0) delete headers[key];
    }
  };

  strip(event.headers);
  strip(event.multiValueHeaders);
}

module.exports.handler = async (event, context) => {
  stripZeroContentLengthIfBodyPresent(event);
  return slsHandler(event, context);
};
