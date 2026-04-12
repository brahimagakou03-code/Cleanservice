"use strict";

/* Référence statique pour que le bundle Netlify inclue le moteur de vues. */
require("ejs");

const serverless = require("serverless-http");
const { app } = require("../../src/app");

module.exports.handler = serverless(app);
