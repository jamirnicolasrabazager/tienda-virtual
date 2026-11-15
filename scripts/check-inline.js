#!/usr/bin/env node
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const htmlPath = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
if (!scripts.length) {
  console.error('No se encontró ningún bloque JavaScript inline en index.html.');
  process.exit(1);
}
for (let i = 0; i < scripts.length; i++) {
  new vm.Script(scripts[i][1], { filename: `index.html:inline-script-${i + 1}` });
}
console.log(`Frontend correcto: ${scripts.length} bloque(s) JavaScript inline analizado(s).`);
