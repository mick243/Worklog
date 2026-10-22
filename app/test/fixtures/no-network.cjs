// 시험용: CLI가 네트워크에 연결하려 하면 바로 종료 코드 97로 멈춰요.
// node --require 로 미리 불러와서 net·dns·http·https·fetch 를 막아요. (서버를 여는 listen은 막지 않아요)
'use strict';
const net = require('node:net');
const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');

function block(name) {
  return function blocked() {
    process.stderr.write(`NETWORK_ATTEMPT:${name}\n`);
    process.exit(97);
  };
}

net.connect = block('net.connect');
net.createConnection = block('net.createConnection');
net.Socket.prototype.connect = block('net.Socket.connect');
tls.connect = block('tls.connect');
dns.lookup = block('dns.lookup');
dns.resolve = block('dns.resolve');
dns.resolve4 = block('dns.resolve4');
dns.resolve6 = block('dns.resolve6');
if (dns.promises) {
  dns.promises.lookup = block('dns.promises.lookup');
  dns.promises.resolve = block('dns.promises.resolve');
}
http.request = block('http.request');
http.get = block('http.get');
https.request = block('https.request');
https.get = block('https.get');
globalThis.fetch = block('fetch');
require('node:module').syncBuiltinESMExports();
