#!/usr/bin/env node
'use strict';
/*
 * cy365_probe.js — sonda de descubrimiento para camaras CY365/SHIX.
 *
 * Manda el LanSearch cifrado (9f a1 ee b9) por broadcast Y por unicast, y muestra
 * CUALQUIER respuesta de la camara decodificada. Sirve para saber si la camara
 * habla el protocolo y con que clave.
 *
 * Uso:  node cy365_probe.js [--ip 192.168.1.26] [--segundos 120]
 */

const dgram = require('dgram');
const os = require('os');

const arg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d;
};
const CAM_IP = arg('ip', '192.168.1.26');
const SEGUNDOS = parseInt(arg('segundos', '120'), 10);

const TABLE = Buffer.from(
  '7c9ce84a13dedcb22f2123e4307b3d8cbc0b270c3cf79ae7087196009785efc11fc4dba1c2ebd901faba3b05b81587832872d18b5ad6da9358feaacc6e1bf0a3' +
  '88ab43c00db545384f502266207f075b14981d9ba72ab9a8cbf1fc4947063eb10e043a945eee541134dd4df9ecc7c9e3781a6f706ba4bda95dd5f8e5bb26af42' +
  '37d8e1020aae5f1cc573094e6924906d12b319ad748a2940f52dbea559e0f479d24bce8982488425c6912ba2fb8fe9a6b09e3f65f603312eac0f952c5ced39b73' +
  '36c567eb4a0fd7a815351868d9f77ff6a80dfe2bf10d775645776f355cdd0c818e6364162cf99f2324c67606192cad3ea637d16b68ed46835c3529d46441e17', 'hex');
const EK = [0x3c, 0xc4, 0x68, 0x0a];
const ks = (prev) => TABLE[(EK[prev & 3] + prev) & 0xff];
const decode = (b) => { const o = Buffer.alloc(b.length); let p = 0; for (let i = 0; i < b.length; i++) { o[i] = b[i] ^ ks(p); p = b[i]; } return o; };
const encode = (b) => { const o = Buffer.alloc(b.length); let p = 0; for (let i = 0; i < b.length; i++) { o[i] = b[i] ^ ks(p); p = o[i]; } return o; };

function subredBroadcast() {
  for (const ifs of Object.values(os.networkInterfaces()))
    for (const i of ifs)
      if (i.family === 'IPv4' && !i.internal) { const p = i.address.split('.'); return `${p[0]}.${p[1]}.${p[2]}.255`; }
  return null;
}

const sock = dgram.createSocket('udp4');
const TIPOS = { 0x00: 'Hello', 0x01: 'HelloAck', 0x20: 'P2pReq', 0x21: 'P2pReqAck', 0x30: 'LanSearch', 0x40: 'PunchTo', 0x41: 'PunchPkt', 0x42: 'P2pRdy', 0xd0: 'Drw', 0xd1: 'DrwAck', 0xe0: 'P2PAlive', 0xe1: 'P2PAliveAck', 0xf0: 'Close' };

sock.on('message', (enc, rinfo) => {
  const d = decode(enc);
  const tipo = TIPOS[d[1]] || ('0x' + d[1].toString(16));
  const hora = new Date().toTimeString().slice(0, 8);
  console.log(`${hora}  <<< ${rinfo.address}:${rinfo.port}  ${tipo}  (${enc.length} bytes)`);
  const payload = d.slice(4);
  const ascii = payload.toString('ascii').replace(/[^\x20-\x7e]/g, '.');
  console.log(`         payload: ${payload.toString('hex')}`);
  if (ascii.trim()) console.log(`         ascii  : ${ascii}`);
  const did = ascii.match(/[A-Z]{3}-?\d+/);
  if (did) console.log(`         posible DID: ${did[0]}`);
});

sock.bind(() => {
  sock.setBroadcast(true);
  const destinos = [
    { address: '255.255.255.255', port: 32108 },
    { address: subredBroadcast() || '192.168.1.255', port: 32108 },
    { address: CAM_IP, port: 32108 },
  ].filter(d => d.address);

  console.log(`Sonda CY365 en el puerto ${sock.address().port} durante ${SEGUNDOS}s`);
  console.log('Destinos: ' + destinos.map(d => `${d.address}:${d.port}`).join(', '));
  console.log('Escuchando respuestas...\n');

  const ls = encode(Buffer.from([0xf1, 0x30, 0x00, 0x00]));
  let n = 0;
  const envio = setInterval(() => {
    for (const d of destinos) sock.send(ls, d.port, d.address);
    n++;
    if (n % 20 === 0) console.log(`(${n} envios)`);
  }, 300);

  setTimeout(() => {
    clearInterval(envio);
    console.log(`\nFin. ${n} envios enviados.`);
    sock.close();
    process.exit(0);
  }, SEGUNDOS * 1000);
});
